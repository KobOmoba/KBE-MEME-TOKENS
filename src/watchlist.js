/**
 * Watchlist — Loop 1 (scanner) second half.
 *
 * Detection (Helius WebSocket + PumpPortal backup) calls add(). A non-overlapping cycle every
 * cfg.watchIntervalMs then:
 *   1. expires tokens at maxTokenAgeMinutes
 *   2. fetches ALL bonding curves in one batched RPC call
 *   3. runs evaluateEntry() on each; buys on PASS
 *
 * It also writes data/watch_log.jsonl: one line per token with its mcap trajectory. This is
 * the dataset to decide entry strategy (window vs block-0 vs volume-spike) from EVIDENCE.
 */

const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { PublicKey } = require('@solana/web3.js');
const { getBondingCurvePda, getBondingCurvesBatch } = require('./api/pumpfun');
const { evaluateEntry } = require('./evaluator');
const { executeBuy } = require('./buyer');
const feed = require('./api/pumpportal');
const stats = require('./utils/stats');
const log = require('./utils/logger').forTag('WATCHLIST');

const entries = new Map();          // mint -> entry
const seen = new Set();             // every mint ever added (bounded) — dedupes Helius + PumpPortal
const SEEN_MAX = 5000;
let running = false;
let timer = null;

const _deps = { getBondingCurvesBatch, executeBuy, now: () => Date.now() };   // test hooks

function add(det) {
  if (!det || !det.mint || seen.has(det.mint)) return false;
  seen.add(det.mint);
  if (seen.size > SEEN_MAX) [...seen].slice(0, 1000).forEach(m => seen.delete(m));

  stats.recordDetection();

  const ageMs = _deps.now() - det.creationTime;
  if (ageMs / 60000 >= cfg.maxTokenAgeMinutes) {          // arrived too late (Helius/RPC lag)
    stats.recordRejection('AGE_GATE', { ageStr: `${Math.floor(ageMs / 60000)}m ${Math.floor((ageMs % 60000) / 1000)}s` });
    return false;
  }
  if (entries.size >= cfg.maxWatchlist) {                  // safety valve for RAM / RPC
    const oldest = entries.values().next().value;
    finalize(oldest, 'DROP', 'WATCHLIST_FULL', {});
  }

  let pda;
  try { pda = getPda(det.mint); } catch (e) { log.warn('bad mint ' + det.mint); return false; }

  const entry = {
    mint: det.mint, pda, creator: det.creator || null, name: det.name, symbol: det.symbol,
    creationTime: det.creationTime, signature: det.signature, source: det.source || 'helius',
    addedAt: _deps.now(),
    peakMcap: 0, peakAgeSec: null, firstMcap: null, samples: [], lastSampleAt: 0,
    buys: 0, sells: 0, trades: 0, devTxns: 0, devSold: false, feed: false,
    enteredWindow: false, lastBlocker: null, lastDetail: null,
  };
  entry.feed = feed.subscribe(det.mint);
  entries.set(det.mint, entry);
  return true;
}

function getPda(mint) {
  // synchronous PDA derivation (same seeds as pumpfun.getBondingCurvePda)
  const { PUMP_FUN_PROGRAM } = require('./api/pumpfun');
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBytes()], PUMP_FUN_PROGRAM)[0];
}

function onTrade(t) {
  const e = entries.get(t.mint);
  if (!e) return;
  e.trades++;
  if (t.type === 'buy') e.buys++; else e.sells++;
  if (e.creator && t.trader === e.creator) {
    e.devTxns++;
    if (t.type === 'sell') e.devSold = true;
  }
}

function finalize(entry, status, reason, detail) {
  entries.delete(entry.mint);
  feed.unsubscribe(entry.mint);
  if (status !== 'PASS') stats.recordRejection(reason, { ...detail, peak: entry.peakMcap });
  writeWatchLog(entry, status, reason);
}

function writeWatchLog(e, status, reason) {
  try {
    const file = cfg.watchLogFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 15 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch (_) {}
    fs.appendFileSync(file, JSON.stringify({
      mint: e.mint, sym: e.symbol || null, src: e.source, created: e.creationTime,
      firstMcap: e.firstMcap && Math.round(e.firstMcap), peakMcap: Math.round(e.peakMcap),
      peakAgeSec: e.peakAgeSec, inWindow: e.enteredWindow, windowAgeSec: e.windowAgeSec ?? null,
      buys: e.buys, sells: e.sells, devSold: e.devSold, feed: e.feed,
      end: status, why: reason, s: e.samples,          // s = [[ageSec, mcapUSD], ...]
    }) + '\n');
  } catch (err) { log.warn('watch log write failed: ' + err.message); }
}

async function runCycle() {
  if (running) return;            // never overlap
  running = true;
  try {
    const now = _deps.now();
    for (const e of [...entries.values()]) {
      if ((now - e.creationTime) / 60000 >= cfg.maxTokenAgeMinutes) {
        finalize(e, 'EXPIRED', e.lastBlocker || 'MCAP_TOO_LOW', e.lastDetail || {});
      }
    }
    stats.setWatching(entries.size);
    if (!entries.size) return;

    const curves = await _deps.getBondingCurvesBatch([...entries.values()].map(e => ({ mint: e.mint, pda: e.pda })));

    for (const e of [...entries.values()]) {
      if (!entries.has(e.mint)) continue;
      const curve = curves.get(e.mint);
      const ageSec = Math.round((now - e.creationTime) / 1000);

      if (curve && curve.state === 'ok') {                       // trajectory bookkeeping
        const m = curve.marketCapUSD;
        if (e.firstMcap === null) e.firstMcap = m;
        if (m > e.peakMcap) { e.peakMcap = m; e.peakAgeSec = ageSec; }
        if (now - e.lastSampleAt >= 9000 && e.samples.length < 40) {
          e.samples.push([ageSec, Math.round(m)]); e.lastSampleAt = now;
        }
      }

      let res;
      try { res = await evaluateEntry(e, curve); }
      catch (err) { log.error(`evaluate error ${e.mint.slice(0, 8)}: ${err.message}`); continue; }

      if (res.status === 'WAIT') { e.lastBlocker = res.reason; e.lastDetail = res.detail; }
      else if (res.status === 'DROP') finalize(e, 'DROP', res.reason, res.detail || {});
      else if (res.status === 'PASS') {
        finalize(e, 'PASS', 'BOUGHT', {});
        stats.recordPass();
        // fire-and-forget: a slow buy must never stall the watch cycle
        Promise.resolve(_deps.executeBuy(res.data)).catch(err =>
          log.error(`executeBuy error ${res.data.ticker}: ${err.message}`));
      }
    }
  } catch (err) {
    log.error('watch cycle error: ' + err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  feed.start({
    onCreate: (d) => add(d),
    onTrade,
    getWatched: () => [...entries.keys()],
  });
  timer = setInterval(() => runCycle().catch(e => log.error(e.message)), cfg.watchIntervalMs);
  log.info(`Watchlist started — cycle every ${cfg.watchIntervalMs / 1000}s, max ${cfg.maxWatchlist} tokens`);
}

module.exports = { add, start, runCycle, onTrade, _entries: entries, _deps };
