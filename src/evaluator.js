/**
 * Evaluator — Gate Sequence V3 §3, V4.2 "watchlist" edition.
 *
 * WHY THIS CHANGED
 * V4.0/4.1 evaluated each token ONCE, a few seconds after launch, when every Pump.fun token
 * sits at ~$4-5k mcap. The entry window is $25k-$35k, so the mcap gate rejected ~everything
 * as TOO LOW and never looked at the token again. A token needs minutes (if it ever gets
 * there) to reach $25k. Now every new token goes on a watchlist and is re-checked every few
 * seconds until it (a) enters the window and passes all gates, (b) blows past $35k,
 * (c) fails a permanent gate, or (d) reaches 5 minutes of age.
 *
 * Gate ORDER is unchanged (age, mcap, liquidity, red flags, concentration, score) and the
 * cheap gates run first: the expensive calls (Helius metadata, holders, txn count) only ever
 * run for tokens that are inside the mcap window.
 *
 * Returns { status: 'PASS' | 'WAIT' | 'DROP', reason, detail, data }
 *   WAIT = not yet, keep watching.   DROP = permanent, stop watching.
 */

const cfg = require('../config');
const { getTopHolderConcentration, getTxnCount } = require('./api/pumpfun');
const { getTokenMeta } = require('./api/helius');
const { scoreToken }   = require('./utils/scorer');
const stats = require('./utils/stats');
const log   = require('./utils/logger').forTag('EVALUATOR');

const HOLDER_TTL = 15000;   // re-fetch holders / txn count at most every 15s per token
const TXN_TTL    = 15000;

const PASS = (data)          => ({ status: 'PASS', data });
const WAIT = (reason, detail) => ({ status: 'WAIT', reason, detail });
const DROP = (reason, detail) => ({ status: 'DROP', reason, detail });

function fmtAge(ms) { return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`; }

async function evaluateEntry(entry, curve) {
  const { mint } = entry;
  const tag = `${mint.slice(0, 8)}...`;
  const now = Date.now();

  // ── GATE 1: AGE ───────────────────────────────────────────────────────────
  const ageMs = now - entry.creationTime;
  const ageMinutes = ageMs / 60000;
  const ageStr = fmtAge(ageMs);
  if (ageMinutes >= cfg.maxTokenAgeMinutes) return DROP('AGE_GATE', { ageMinutes, ageStr });

  // ── GATE 2: MCAP ──────────────────────────────────────────────────────────
  if (!curve || curve.state === 'missing') {
    entry.curveMisses = (entry.curveMisses || 0) + 1;
    return entry.curveMisses >= 6 ? DROP('CURVE_FETCH_ERROR', {}) : WAIT('CURVE_FETCH_ERROR', {});
  }
  entry.curveMisses = 0;
  if (curve.state === 'graduated') return DROP('TOKEN_GRADUATED', {});

  const mcap = curve.marketCapUSD;
  if (mcap === null || mcap === undefined || isNaN(mcap) || mcap <= 0) {
    log.warn(`[${tag}] mcap zero/null/NaN`);
    return WAIT('MCAP_ZERO', { mcap });
  }
  // V4.2: above the window is NOT permanent any more. Volatile tokens dip back; keep watching
  // until the 5-minute age limit. Entry after a dip is flagged so it can be analysed separately.
  if (mcap > cfg.mcapMax) { entry.wasAbove = true; return WAIT('MCAP_TOO_HIGH', { mcap, peak: entry.peakMcap }); }
  if (mcap < cfg.mcapMin) return WAIT('MCAP_TOO_LOW', { mcap, peak: entry.peakMcap });

  if (!entry.enteredWindow) {
    entry.enteredWindow = true;
    entry.windowAgeSec = Math.round(ageMs / 1000);
    stats.recordWindowEntry();
    log.info(`[${tag}] entered mcap window at $${mcap.toFixed(0)} (age ${ageStr})`);
  }

  // ── GATE 3: LIQUIDITY ─────────────────────────────────────────────────────
  const liq = curve.liquidityUSD;
  if (!liq || liq < cfg.minLiquidityForBuy) return WAIT('LIQUIDITY_GATE', { liquidity: liq });

  // ── GATE 4: RED FLAGS ─────────────────────────────────────────────────────
  if (!entry.meta) entry.meta = await getTokenMeta(mint).catch(() => ({}));
  const meta = entry.meta;
  const redFlags = [], greenFlags = [];

  if (meta.mintAuthorityRevoked === false)   redFlags.push('Mint authority NOT revoked ❌');
  else greenFlags.push('Mint authority revoked ✅');
  if (meta.freezeAuthorityRevoked === false) redFlags.push('Freeze authority NOT revoked ❌');
  else greenFlags.push('Freeze authority revoked ✅');

  const feed = !!entry.feed;      // do we have live trade data for this token?
  if (feed && entry.devSold) redFlags.push('Developer SOLD ❌');
  else if (feed && entry.devTxns > 0 && ageMinutes < 2) redFlags.push('Developer transacting in first 2 min ❌');

  if (meta.hasTwitter)  greenFlags.push('Twitter ✅');
  if (meta.hasTelegram) greenFlags.push('Telegram ✅');
  if (meta.hasWebsite)  greenFlags.push('Website ✅');

  if (redFlags.length) return DROP('RED_FLAG', redFlags);

  // ── GATE 5: WALLET CONCENTRATION ──────────────────────────────────────────
  if (!entry.holders || now - entry.holdersAt > HOLDER_TTL) {
    const h = await getTopHolderConcentration(mint, entry.creator);
    if (!h.ok) return WAIT('HOLDER_FETCH_ERROR', {});
    entry.holders = h; entry.holdersAt = now;
  }
  const { top10Pct, devHoldingPct } = entry.holders;
  const devTxns = feed ? entry.devTxns : null;

  if (top10Pct > cfg.maxWalletConcentration) {
    // Override needs BOTH: dev < 10% supply AND zero dev txns. Unknown = cannot verify = no override.
    const overrideA = devHoldingPct !== null && devHoldingPct < cfg.devMaxHoldingPct;
    const overrideB = devTxns === 0;
    if (!(overrideA && overrideB)) {
      return WAIT('CONCENTRATION_GATE', { top10Pct, devHoldingPct, devTxns });
    }
    greenFlags.push(`Concentration override: dev ${devHoldingPct.toFixed(1)}% + 0 txns ✅`);
  } else {
    greenFlags.push(`Top 10 wallets: ${top10Pct.toFixed(1)}% ✅`);
  }

  // ── GATE 6: SCORE ─────────────────────────────────────────────────────────
  if (entry.txnCount == null || now - entry.txnAt > TXN_TTL) {
    const n = await getTxnCount(entry.pda);
    if (n != null) { entry.txnCount = n; entry.txnAt = now; }
  }
  const txnCount = Math.max(entry.txnCount || 0, entry.trades || 0) || null;

  let buySellRatio = null;
  if (feed && (entry.buys + entry.sells) >= 5) {
    buySellRatio = entry.sells === 0 ? Math.min(entry.buys, 10) : entry.buys / entry.sells;
  }

  const { score, scaled, breakdown } = scoreToken({
    ticker: meta.symbol || tag,
    buySellRatio,
    transactionCount: txnCount,
    top10HolderPct: top10Pct,
    liquidity: liq,
    hasTwitter: !!meta.hasTwitter, hasTelegram: !!meta.hasTelegram, hasWebsite: !!meta.hasWebsite,
    devHoldingPct, devTransactionCount: devTxns,
  });
  entry.lastScore = score;

  if (cfg.scoreGateEnabled && score < cfg.minScore) {
    log.info(`[${tag}] score ${score}/100 < ${cfg.minScore}${scaled ? ' (scaled)' : ''} | mcap $${mcap.toFixed(0)} | ` +
      Object.entries(breakdown).map(([k, v]) => `${k}=${v.score}`).join(' '));
    return WAIT('SCORE_GATE', { score, breakdown, scaled });
  }
  if (scaled) greenFlags.push('⚠️ Score scaled — some inputs unavailable');
  if (!cfg.scoreGateEnabled) greenFlags.push(`Score ${score}/100 (advisory — gate OFF)`);
  if (entry.wasAbove) greenFlags.push(`⚠️ Dip re-entry — token had peaked at $${Math.round(entry.peakMcap).toLocaleString()}`);

  log.info(`[${tag}] ✅✅✅ ALL GATES PASSED — score ${score}/100 mcap $${mcap.toFixed(0)} age ${ageStr}`);
  return PASS({
    mint,
    name: meta.name || entry.name || 'Unknown',
    ticker: meta.symbol || entry.symbol || mint.slice(0, 8),
    ageStr, ageMinutes,
    entryPrice: curve.priceUSD, entryMcap: mcap, liquidity: liq,
    score, scoreBreakdown: breakdown, scoreScaled: scaled,
    buySellRatio: buySellRatio ?? 0,
    transactionCount: txnCount ?? 0,
    devHoldingPct: devHoldingPct ?? 0,
    devTxns: devTxns ?? 0,
    top10Pct, greenFlags, redFlags,
    hasTwitter: !!meta.hasTwitter, hasTelegram: !!meta.hasTelegram, hasWebsite: !!meta.hasWebsite,
    entryMode: entry.wasAbove ? 'dip' : 'climb',
    peakMcapAtEntry: entry.peakMcap,
    creator: entry.creator,
    detectionSignature: entry.signature,
    creationTime: entry.creationTime,
  });
}

module.exports = { evaluateEntry };
