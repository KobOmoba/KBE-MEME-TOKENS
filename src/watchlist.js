/**
 * Watchlist — Loop 1 (scanner) second half.  V4.2
 *
 * Detection (Helius WebSocket + PumpPortal backup) calls add(). A non-overlapping cycle every
 * cfg.watchIntervalMs then:
 *   1. expires tokens at maxTokenAgeMinutes (no more buys after that)
 *   2. fetches ALL bonding curves in one batched RPC call
 *   3. runs evaluateEntry() on each; buys on PASS
 *
 * SHADOW TRACKING: a token that reached >= mcapMin but was not bought is NOT forgotten at
 * 5 minutes. It is followed (data only, never bought) up to cfg.shadowTrackMinutes so we can
 * measure how many "missed" tokens really ran. This is the evidence for whether the age /
 * mcap cutoffs cost us winners.
 *
 * data/watch_log.jsonl: one line per token with its mcap trajectory ([ageSec, mcapUSD]).
 */

const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { PublicKey } = require('@solana/web3.js');
const pumpfun = require('./api/pumpfun');
const rpc = require('./api/rpc');
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

// Heartbeat counters — printed every 60s so the logs show WHICH source is actually delivering
const counters = { addedPortal: 0, addedLogs: 0, addedTx: 0, createLogs: 0, decodeOk: 0, decodeFail: 0, trades: 0, chainReads: 0, chainFails: 0 };

let pendingBuys = 0;
const _deps = { getBondingCurvesBatch: pumpfun.getBondingCurvesBatch, executeBuy, openCount: () => require('./buyer').openCount(), now: () => Date.now() };   // test hooks

function getPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBytes()], pumpfun.PUMP_FUN_PROGRAM)[0];
}

function add(det) {
  if (!det || !det.mint || seen.has(det.mint)) return false;
  seen.add(det.mint);
  if (seen.size > SEEN_MAX) [...seen].slice(0, 1000).forEach(m => seen.delete(m));

  stats.recordDetection();
  if (det.source === 'pumpportal') counters.addedPortal++; else if (det.source === 'logs') counters.addedLogs++; else counters.addedTx++;

  const ageMs = _deps.now() - det.creationTime;
  if (ageMs / 60000 >= cfg.maxTokenAgeMinutes) {          // arrived too late (Helius/RPC lag)
    stats.recordRejection('AGE_GATE', { ageStr: `${Math.floor(ageMs / 60000)}m ${Math.floor((ageMs % 60000) / 1000)}s` });
    return false;
  }
  if (entries.size >= cfg.maxWatchlist) {                  // safety valve for RAM / RPC
    const victim = [...entries.values()].find(e => e.shadow) || entries.values().next().value;   // sacrifice data-only tokens first
    finalize(victim, 'DROP', 'WATCHLIST_FULL', {});
  }

  let pda;
  try { pda = getPda(det.mint); } catch (e) { log.warn('bad mint ' + det.mint); return false; }

  const entry = {
    mint: det.mint, pda, creator: det.creator || null, name: det.name, symbol: det.symbol,
    creationTime: det.creationTime, signature: det.signature, source: det.source || 'helius',
    addedAt: _deps.now(),
    peakMcap: 0, peakAgeSec: null, firstMcap: null, samples: [], lastSampleAt: 0,
    buys: 0, sells: 0, trades: 0, devTxns: 0, devSold: false, feed: false,
    enteredWindow: false, wasAbove: false, shadow: false, rejectionRecorded: false,
    lateWindowAgeSec: null, graduatedAgeSec: null, lastBlocker: null, lastDetail: null,
  };
  entry.feed = feed.subscribe(det.mint);
  entries.set(det.mint, entry);
  return true;
}

/**
 * V4.2d: PumpPortal is the PRIMARY data source, Helius RPC is the verifier / fallback.
 *  - token with fresh feed data far from the window  -> no RPC call at all
 *  - token with feed data near the window            -> ONE batched on-chain read to verify
 *  - token with no usable feed data                  -> batched on-chain read (fallback)
 *  - RPC down / rate limited                         -> keep running on feed data only
 */
async function gatherCurves(list) {
  const solPrice = await rpc.getSolPrice();
  const curves = new Map(), needRpc = [];
  const feedUp = feed.isConnected();

  for (const e of list) {
    const fl = feed.getLatest(e.mint);
    if (fl && !fl.stale && feedUp) {
      const mcapUSD = fl.mcapSol * solPrice;
      curves.set(e.mint, {
        state: 'ok', source: 'feed', marketCapUSD: mcapUSD, priceUSD: mcapUSD / 1e9,
        liquidityUSD: fl.vSol != null ? Math.max(0, fl.vSol - 30) * 2 * solPrice : 0,   // vSol starts at 30
      });
      if (!e.shadow && mcapUSD >= cfg.mcapMin * 0.9 && mcapUSD <= cfg.mcapMax * 1.1) needRpc.push(e);
    } else if (!e.shadow) {
      needRpc.push(e);                                             // no usable feed data => chain fallback
    } else if (Date.now() - (e.lastRpcAt || 0) > 30000) {          // shadow: data-only, throttled
      e.lastRpcAt = Date.now();
      needRpc.push(e);
    }
  }

  let rpcOk = true;
  if (needRpc.length) {
    counters.chainReads += needRpc.length;
    try {
      const r = await _deps.getBondingCurvesBatch(needRpc.map(e => ({ mint: e.mint, pda: e.pda })));
      for (const e of needRpc) {
        const rc = r.get(e.mint), fc = curves.get(e.mint);
        if (rc && rc.state === 'ok') {
          if (fc && Math.abs(rc.marketCapUSD - fc.marketCapUSD) / rc.marketCapUSD > 0.15) {
            log.warn(`FEED MISMATCH ${e.mint.slice(0, 8)}: feed $${Math.round(fc.marketCapUSD)} vs chain $${Math.round(rc.marketCapUSD)} — trusting chain`);
          }
          curves.set(e.mint, rc);                                  // on-chain is authoritative
        } else if (rc && rc.state === 'graduated') curves.set(e.mint, rc);
        else if (!fc) curves.set(e.mint, rc);                      // 'missing' and no feed data
      }
    } catch (err) {
      rpcOk = false; counters.chainFails++;
      if (Date.now() - (gatherCurves._warnAt || 0) > 60000) {                     // warn once a minute, not every cycle
        gatherCurves._warnAt = Date.now();
        log.warn(`RPC unavailable (${String(err.message).slice(0, 60)}) — running on feed data only`);
      }
    }
  }
  return { curves, rpcOk };
}

function onTrade(t) {
  counters.trades++;
  const e = entries.get(t.mint);
  if (!e || e.shadow) return;
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
  if (status !== 'PASS' && !entry.rejectionRecorded) {
    stats.recordRejection(reason, { ...detail, peak: entry.peakMcap });
  }
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
      wasAbove: e.wasAbove, shadow: e.shadow, lateWindowAgeSec: e.lateWindowAgeSec, gradAgeSec: e.graduatedAgeSec,
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

    // 1. expiry: stop BUYING at maxTokenAgeMinutes; promising tokens continue as shadow (data only)
    for (const e of [...entries.values()]) {
      const ageMin = (now - e.creationTime) / 60000;
      if (e.shadow) {
        if (ageMin >= cfg.shadowTrackMinutes) finalize(e, 'SHADOW_END', e.lastBlocker || 'MCAP_TOO_LOW', e.lastDetail || {});
        continue;
      }
      if (ageMin >= cfg.maxTokenAgeMinutes) {
        const reason = e.lastBlocker || 'MCAP_TOO_LOW', detail = e.lastDetail || {};
        stats.recordRejection(reason, { ...detail, peak: e.peakMcap });
        e.rejectionRecorded = true;
        if (cfg.shadowTrackMinutes > cfg.maxTokenAgeMinutes && e.peakMcap >= Math.max(cfg.mcapMin, cfg.shadowMinPeak)) {
          e.shadow = true;                       // stays subscribed: free price data for the research log
        } else finalize(e, 'EXPIRED', reason, detail);
      }
    }
    stats.setWatching([...entries.values()].filter(e => !e.shadow).length);
    if (!entries.size) return;

    // 2. one batched RPC call for every watched token
    const { curves } = await gatherCurves([...entries.values()]);

    // 3. evaluate
    const capFull = _deps.openCount() + pendingBuys >= cfg.maxOpenPositions;
    for (const e of [...entries.values()]) {
      if (!entries.has(e.mint)) continue;
      const curve = curves.get(e.mint);
      const ageSec = Math.round((now - e.creationTime) / 1000);

      if (curve && curve.state === 'ok') {                       // trajectory bookkeeping
        const m = curve.marketCapUSD;
        if (e.firstMcap === null) e.firstMcap = m;
        if (m > e.peakMcap) { e.peakMcap = m; e.peakAgeSec = ageSec; }
        const every = e.shadow ? 30000 : 9000, cap = e.shadow ? 100 : 40;
        if (now - e.lastSampleAt >= every && e.samples.length < cap) {
          e.samples.push([ageSec, Math.round(m)]); e.lastSampleAt = now;
        }
        if (ageSec / 60 >= cfg.maxTokenAgeMinutes && m >= cfg.mcapMin && m <= cfg.mcapMax && e.lateWindowAgeSec === null) {
          e.lateWindowAgeSec = ageSec;                            // would have qualified, but too old
        }
      } else if (curve && curve.state === 'graduated' && e.graduatedAgeSec === null) {
        e.graduatedAgeSec = ageSec;
      }

      if (e.shadow) {                                             // follow only, never buy
        if (curve && curve.state === 'graduated') finalize(e, 'SHADOW_END', 'GRADUATED', {});
        continue;
      }

      if (capFull) {                                              // no free slot: skip the (chain-calling) gates
        e.lastBlocker = 'POSITION_CAP'; e.lastDetail = {};
        continue;
      }

      let res;
      try { res = await evaluateEntry(e, curve); }
      catch (err) { log.error(`evaluate error ${e.mint.slice(0, 8)}: ${err.message}`); continue; }

      if (res.status === 'WAIT') { e.lastBlocker = res.reason; e.lastDetail = res.detail; }
      else if (res.status === 'DROP') finalize(e, 'DROP', res.reason, res.detail || {});
      else if (res.status === 'PASS') {
        if (_deps.openCount() + pendingBuys >= cfg.maxOpenPositions) {     // all slots busy: stay on the list
          e.lastBlocker = 'POSITION_CAP'; e.lastDetail = {}; continue;
        }
        pendingBuys++;
        feed.pin(e.mint);                       // keep the free price feed alive while the position is open
        entries.delete(e.mint);                 // (no unsubscribe: pinned)
        writeWatchLog(e, 'PASS', 'BOUGHT');
        stats.recordPass();
        // fire-and-forget: a slow buy must never stall the watch cycle
        Promise.resolve(_deps.executeBuy(res.data))
          .catch(err => log.error(`executeBuy error ${res.data.ticker}: ${err.message}`))
          .finally(() => { pendingBuys--; });
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
  setInterval(() => {
    const c = counters, all = [...entries.values()];
    log.info(`💓 watching ${all.filter(e => !e.shadow).length} (+${all.filter(e => e.shadow).length} shadow) | new tokens: portal ${c.addedPortal} logs ${c.addedLogs} tx ${c.addedTx}`
      + ` | create-logs seen ${c.createLogs} decoded ${c.decodeOk} failed ${c.decodeFail} | feed trades ${c.trades}`
      + ` | chain reads ${c.chainReads} fails ${c.chainFails} | portal ${feed.isHealthy() ? 'HEALTHY' : feed.isConnected() ? 'CONNECTED-NO-DATA' : 'DOWN'}`);
  }, 60000);
  log.info(`Watchlist started — cycle every ${cfg.watchIntervalMs / 1000}s, max ${cfg.maxWatchlist} tokens, shadow-track ${cfg.shadowTrackMinutes} min`);
}

module.exports = { add, start, runCycle, onTrade, counters, _entries: entries, _deps };
