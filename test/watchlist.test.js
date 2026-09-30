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
let socials = true;
hel.getTokenMeta = async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, hasTwitter: socials, hasTelegram: socials, hasWebsite: false, symbol: 'TST', name: 'Test' });
const feed = require('../src/api/pumpportal');
let feedUp = true;
feed.subscribe = () => feedUp; feed.unsubscribe = () => {};

require('../src/api/rpc').getSolPrice = async () => 150;
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

test('token above $35k is NOT dropped: not bought while above, bought if it dips back into the window', async () => {
  bought.length = 0;
  const m = spawn(); buys(m); mcaps[m] = 6000; await wl.runCycle();
  mcaps[m] = 52000; await wl.runCycle();
  assert.equal(bought.length, 0, 'never buy above the window'); assert.equal(wl._entries.has(m), true, 'still watched');
  mcaps[m] = 33000; await wl.runCycle();
  assert.equal(bought.length, 1, 'dip back into window => buy'); assert.equal(bought[0].entryMode, 'dip');
  assert.ok(bought[0].peakMcapAtEntry >= 52000);
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

test('score is ADVISORY by default: low-score token is still bought and the score is recorded', async () => {
  bought.length = 0; socials = false; holders = { ok: true, top10Pct: 28, devHoldingPct: 2 };
  const m = spawn(); buys(m); mcaps[m] = 28000; await wl.runCycle();
  assert.equal(bought.length, 1); assert.ok(bought[0].score < cfg.minScore, `score ${bought[0].score} should be below ${cfg.minScore}`);
  assert.ok(bought[0].scoreBreakdown, 'breakdown stored for later analysis');
  // and the gate still works when switched on
  bought.length = 0; cfg.scoreGateEnabled = true;
  const m2 = spawn(); buys(m2); mcaps[m2] = 28000; await wl.runCycle();
  assert.equal(bought.length, 0, 'gate ON blocks the same token');
  wl._entries.delete(m2);                       // do not leak a waiting token into later tests
  cfg.scoreGateEnabled = false; socials = true; holders = { ok: true, top10Pct: 18, devHoldingPct: 2 };
});

test('shadow tracking: promising token is followed past 5 min (never bought), late window entry recorded', async () => {
  bought.length = 0; holders = { ok: true, top10Pct: 42, devHoldingPct: 3 };     // blocks the buy
  const m = spawn(); buys(m); const e = wl._entries.get(m);
  e.creationTime = Date.now() - 2.5 * 60000; wl.onTrade({ mint: m, trader: e.creator, type: 'buy' });
  mcaps[m] = 28000; await wl.runCycle();
  e.creationTime = Date.now() - 5.5 * 60000; mcaps[m] = 30000; await wl.runCycle();   // 5.5 min: past buy cutoff
  assert.equal(e.shadow, true); assert.equal(wl._entries.has(m), true);
  assert.equal(bought.length, 0); assert.ok(e.lateWindowAgeSec >= 330, 'late in-window sighting recorded');
  mcaps[m] = 90000; e.lastRpcAt = 0; await wl.runCycle();                           // (30s throttle elapsed)
  e.creationTime = Date.now() - 31 * 60000; await wl.runCycle();                      // shadow period over
  assert.equal(wl._entries.has(m), false);
  const line = fs.readFileSync(cfg.watchLogFile, 'utf8').trim().split('\n').map(JSON.parse).find(x => x.mint === m);
  assert.equal(line.shadow, true); assert.equal(line.peakMcap, 90000); assert.ok(line.lateWindowAgeSec >= 330);
  holders = { ok: true, top10Pct: 18, devHoldingPct: 2 };
});

test('moon bag: 12% trailing stop from ATH, only after BOTH tiers', async () => {
  const sellerMod = require('../src/seller'); const sells = [];
  sellerMod.executeSell = async (pos, _p, reason, pct, price) => { sells.push({ reason, pct, price }); };
  pf.getBondingCurveData = async () => ({ priceUSD: px });
  cfg.positionsFile = path.join(os.tmpdir(), `pos_${Date.now()}.json`);
  const tracker = require('../src/tracker');
  let px = 1; const positions = new Map(); tracker.init(positions);
  const mk = (o) => ({ mint: 'M' + Math.random(), ticker: 'T', entryPrice: 1, currentPrice: 1, peakPrice: 1, timerExpiry: Date.now() + 9e5,
    tier1Sold: true, tier2Sold: true, stopLossAlerted: false, paperTrade: true, ...o });

  const p = mk({}); positions.set(p.mint, p);
  px = 5.0; await tracker.runMonitorCycle(); assert.equal(sells.length, 0, 'new ATH 5x, no sell');
  px = 4.5; await tracker.runMonitorCycle(); assert.equal(sells.length, 0, '-10% from ATH: hold');
  px = 4.39; await tracker.runMonitorCycle(); assert.equal(sells.length, 1, '-12.2% from ATH: sell');
  assert.equal(sells[0].reason, 'STOP_LOSS'); assert.equal(sells[0].pct, cfg.moonBagPct);

  sells.length = 0; positions.clear();
  const q = mk({ tier2Sold: false, peakPrice: 4.2 }); positions.set(q.mint, q);   // tier 2 NOT done => no stop
  px = 2.0; await tracker.runMonitorCycle(); assert.equal(sells.filter(x => x.reason === 'STOP_LOSS').length, 0, 'no stop before both tiers');
});

test('PumpPortal is not "healthy" unless connected and delivering (Helius fallback stays on)', () => {
  const real = require('../src/api/pumpportal');
  assert.equal(real.isHealthy(), false);
});

// ── V4.2d: PumpPortal primary, RPC verifier/fallback ──────────────────────────
const feedPrice = {};                                   // mint -> { mcapSol, vSol }
const realGetLatest = feed.getLatest, realIsConnected = feed.isConnected;
const useFeed = () => { feed.getLatest = (m) => feedPrice[m] ? { ...feedPrice[m], stale: false } : null; feed.isConnected = () => true; };
const unuseFeed = () => { feed.getLatest = realGetLatest; feed.isConnected = realIsConnected; };
const sol = (usd) => usd / 150;                         // test SOL price is $150

test('feed-priced token far from the window costs ZERO rpc calls', async () => {
  wl._entries.clear(); useFeed(); let rpcCalls = 0; const orig = wl._deps.getBondingCurvesBatch;
  wl._deps.getBondingCurvesBatch = async (i) => { rpcCalls += i.length; return orig(i); };
  const m = spawn(); feedPrice[m] = { mcapSol: sol(6000), vSol: 32 };
  await wl.runCycle();
  assert.equal(rpcCalls, 0, 'no chain read needed while token is at $6k');
  wl._deps.getBondingCurvesBatch = orig; wl._entries.delete(m); unuseFeed();
});

test('near the window the chain is consulted and OVERRIDES a wrong feed value', async () => {
  wl._entries.clear(); useFeed(); bought.length = 0; const seenBy = [];
  const m = spawn(); buys(m);
  feedPrice[m] = { mcapSol: sol(30000), vSol: 80 };     // feed says $30k
  mcaps[m] = 60000;                                     // chain says $60k (feed is wrong)
  await wl.runCycle();
  assert.equal(bought.length, 0, 'chain value $60k is above the window => no buy');
  assert.equal(wl._entries.get(m).lastBlocker, 'MCAP_TOO_HIGH');
  wl._entries.delete(m); unuseFeed();
});

test('RPC down: paper keeps trading on the feed (holders flagged unverified); live refuses', async () => {
  wl._entries.clear(); useFeed(); bought.length = 0;
  const orig = wl._deps.getBondingCurvesBatch; wl._deps.getBondingCurvesBatch = async () => { throw new Error('429 Too Many Requests'); };
  const prevHolders = holders; holders = { ok: false };
  const m = spawn(); buys(m); feedPrice[m] = { mcapSol: sol(28000), vSol: 80 };
  await wl.runCycle();
  assert.equal(bought.length, 1, 'paper buys on feed data');
  assert.ok(bought[0].greenFlags.some(f => /unverified/i.test(f)), 'flagged as unverified');
  assert.ok(bought[0].greenFlags.some(f => /feed/i.test(f)));

  bought.length = 0; cfg.paperTrade = false;            // LIVE mode: never on unverified data
  const m2 = spawn(); buys(m2); feedPrice[m2] = { mcapSol: sol(28000), vSol: 80 };
  await wl.runCycle();
  assert.equal(bought.length, 0, 'live must not trade without on-chain verification');
  assert.equal(wl._entries.get(m2).lastBlocker, 'RPC_UNVERIFIED');
  cfg.paperTrade = true; wl._entries.delete(m2);
  wl._deps.getBondingCurvesBatch = orig; holders = prevHolders; unuseFeed();
});

test('log decoder: reads mint/creator from a Pump.fun CreateEvent and refuses anything inconsistent', () => {
  const { decodeCreateEvent, CREATE_EVENT_DISC } = require('../src/api/pumpEvent');
  const { Keypair, PublicKey } = require('@solana/web3.js');
  const str = (t) => { const b = Buffer.from(t); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const mintK = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintK.toBytes()], pf.PUMP_FUN_PROGRAM)[0];
  const ev = (c, disc = CREATE_EVENT_DISC) => 'Program data: ' + Buffer.concat([disc, str('Test'), str('TST'), str('https://x/y'),
    mintK.toBytes(), c.toBytes(), user.toBytes(), Buffer.alloc(40)]).toString('base64');
  const logs = ['Program log: Instruction: Create', ev(curve)];
  const d = decodeCreateEvent(logs);
  assert.equal(d.mint, mintK.toBase58()); assert.equal(d.creator, user.toBase58()); assert.equal(d.symbol, 'TST');
  assert.equal(decodeCreateEvent(['Program data: ' + ev(curve).slice(14).slice(0, 30)]), null, 'truncated => null');
  assert.equal(decodeCreateEvent([ev(Keypair.generate().publicKey)]), null, 'curve != PDA(mint) => layout drift => refuse');
  assert.equal(decodeCreateEvent([ev(curve, Buffer.alloc(8))]), null, 'wrong discriminator => null');
  assert.equal(decodeCreateEvent(undefined), null);
});
