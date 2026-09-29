// Simulation tests — no network. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');

const cfg = require('../config');
cfg.watchLogFile = path.join(os.tmpdir(), `watch_${Date.now()}.jsonl`);

// ── stub network-touching modules BEFORE loading evaluator/watchlist ──
const pf = require('../src/api/pumpfun');
let holders = { ok: true, top10Pct: 18, devHoldingPct: 2 };
pf.getTopHolderConcentration = async () => holders;
pf.getTxnCount = async () => 180;
const hel = require('../src/api/helius');
hel.getTokenMeta = async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, hasTwitter: true, hasTelegram: true, hasWebsite: false, symbol: 'TST', name: 'Test' });
const feed = require('../src/api/pumpportal');
let feedUp = true;
feed.subscribe = () => feedUp; feed.unsubscribe = () => {};

const wl = require('../src/watchlist');
const stats = require('../src/utils/stats');

let mcaps = {}; const bought = [];
wl._deps.getBondingCurvesBatch = async (items) => new Map(items.map(i => [i.mint,
  mcaps[i.mint] == null ? { state: 'missing' } :
  { state: 'ok', marketCapUSD: mcaps[i.mint], priceUSD: mcaps[i.mint] / 1e9, liquidityUSD: 15000 }]));
wl._deps.executeBuy = async (d) => { bought.push(d); };

let n = 0;
const mint = () => require('@solana/web3.js').Keypair.generate().publicKey.toString();
const spawn = (o = {}) => { const m = mint(); wl.add({ mint: m, creator: mint(), creationTime: Date.now() - 5000, ...o }); return m; };
const buys = (m) => { for (let i = 0; i < 12; i++) wl.onTrade({ mint: m, trader: mint(), type: 'buy' }); wl.onTrade({ mint: m, trader: mint(), type: 'sell' }); };

test('token that climbs into the window is bought exactly once, and not before', async () => {
  bought.length = 0;
  const m = spawn(); buys(m);
  mcaps[m] = 4500;  await wl.runCycle(); assert.equal(bought.length, 0);
  mcaps[m] = 12000; await wl.runCycle(); assert.equal(bought.length, 0);
  mcaps[m] = 27000; await wl.runCycle(); assert.equal(bought.length, 1, 'should buy on entering window');
  assert.equal(bought[0].mint, m);
  mcaps[m] = 30000; await wl.runCycle(); assert.equal(bought.length, 1, 'no double buy');
  assert.equal(wl.add({ mint: m, creationTime: Date.now() }), false, 'duplicate add rejected');
});

test('token that jumps straight past $35k is dropped, never bought', async () => {
  bought.length = 0;
  const m = spawn(); mcaps[m] = 6000; await wl.runCycle();
  mcaps[m] = 52000; await wl.runCycle();
  assert.equal(bought.length, 0); assert.equal(wl._entries.has(m), false);
});

test('token that never reaches $25k expires and is logged with its peak', async () => {
  const m = spawn(); mcaps[m] = 7000; await wl.runCycle();
  wl._entries.get(m).creationTime = Date.now() - 5.2 * 60000;
  await wl.runCycle();
  assert.equal(wl._entries.has(m), false);
  const line = fs.readFileSync(cfg.watchLogFile, 'utf8').trim().split('\n').map(JSON.parse).find(x => x.mint === m);
  assert.equal(line.why, 'MCAP_TOO_LOW'); assert.equal(line.peakMcap, 7000); assert.equal(line.inWindow, false);
});

test('dev sell = red flag = dropped', async () => {
  bought.length = 0;
  const m = spawn(); const e = wl._entries.get(m); buys(m);
  wl.onTrade({ mint: m, trader: e.creator, type: 'sell' });
  mcaps[m] = 28000; await wl.runCycle();
  assert.equal(bought.length, 0); assert.equal(wl._entries.has(m), false);
});

test('high concentration with no dev override waits, does not buy', async () => {
  bought.length = 0; holders = { ok: true, top10Pct: 42, devHoldingPct: 3 };
  const m = spawn(); buys(m);
  const e = wl._entries.get(m); e.creationTime = Date.now() - 2.5 * 60000;   // past the 2-min red-flag window
  wl.onTrade({ mint: m, trader: e.creator, type: 'buy' });                     // dev transacted => override unavailable
  mcaps[m] = 28000; await wl.runCycle();
  assert.equal(bought.length, 0); assert.equal(wl._entries.get(m).lastBlocker, 'CONCENTRATION_GATE');
  holders = { ok: true, top10Pct: 18, devHoldingPct: 2 };
});

test('trade feed down: score is scaled, unknown dev data blocks the override', async () => {
  bought.length = 0; feedUp = false; holders = { ok: true, top10Pct: 42, devHoldingPct: 3 };
  const m1 = spawn(); mcaps[m1] = 28000; await wl.runCycle();
  assert.equal(bought.length, 0, 'unverifiable dev => override not granted');
  holders = { ok: true, top10Pct: 12, devHoldingPct: 1 };
  const m2 = spawn(); mcaps[m2] = 28000; await wl.runCycle();
  assert.equal(bought.length, 1); assert.equal(bought[0].scoreScaled, true);
  feedUp = true;
});

test('token arriving already too old is rejected as AGE_GATE', () => {
  assert.equal(wl.add({ mint: mint(), creationTime: Date.now() - 6 * 60000 }), false);
});

test('scorer: perfect inputs can now clear 65; zeros are not treated as worst-case', () => {
  const { scoreToken } = require('../src/utils/scorer');
  const good = scoreToken({ buySellRatio: 3.2, transactionCount: 160, top10HolderPct: 14, liquidity: 15000,
    hasTwitter: true, hasTelegram: true, hasWebsite: false, devHoldingPct: 0, devTransactionCount: 0 });
  assert.ok(good.score >= 65, `expected >=65 got ${good.score}`);
  assert.equal(good.breakdown.dev.score, 10, 'dev 0%/0 txns must earn full dev points');
  const unknown = scoreToken({ top10HolderPct: 12, liquidity: 15000, transactionCount: 200, hasTwitter: true });
  assert.equal(unknown.scaled, true);
});

test('funnel stats report window entries and peak percentiles', () => {
  const s = stats.getSummary();
  assert.match(s.extraLines, /Entered \$25k-\$35k window: \d+/);
  assert.match(s.extraLines, /median/);
});
