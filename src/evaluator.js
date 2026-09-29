/**
 * Evaluator — Gate Sequence V3 §3
 *
 * Gates run in EXACT ORDER. First failure returns immediately.
 * Every rejection is now recorded in stats.js and logged with full detail.
 *
 * PITFALL FIX #4: MCap gate rejects fdv=0 or null explicitly.
 * PITFALL FIX #5 / TASK 3: Age gate is Gate 1 — before any API calls.
 */

const cfg       = require('../config');
const { getBondingCurveData, getTopHolderConcentration } = require('./api/pumpfun');
const { getTokenMeta }    = require('./api/helius');
const { scoreToken }      = require('./utils/scorer');
const stats               = require('./utils/stats');
const log                 = require('./utils/logger').forTag('EVALUATOR');

const PASS = (data)           => ({ pass: true,  data });
const FAIL = (reason, detail) => ({ pass: false, reason, detail });

async function evaluate(detection) {
  const { mint, creationTime, creator } = detection;
  const tag = `${mint.slice(0, 8)}...`;

  stats.recordDetection();

  // ── GATE 1: AGE ────────────────────────────────────────────────────────────
  const ageMs      = Date.now() - creationTime;
  const ageMinutes = ageMs / 60000;
  const ageStr     = `${Math.floor(ageMinutes)}m ${Math.floor((ageMs % 60000) / 1000)}s`;

  if (ageMinutes >= cfg.maxTokenAgeMinutes) {
    log.debug(`[${tag}] ❌ GATE 1 FAIL — age ${ageStr} (limit: ${cfg.maxTokenAgeMinutes} min)`);
    stats.recordRejection('AGE_GATE', { ageMinutes, ageStr });
    return FAIL('AGE_GATE', { ageMinutes, ageStr });
  }
  log.debug(`[${tag}] ✅ Gate 1 — age ${ageStr}`);

  // ── GATE 2: MCAP ───────────────────────────────────────────────────────────
  let curveData;
  try {
    curveData = await getBondingCurveData(mint);
  } catch (err) {
    log.warn(`[${tag}] ❌ GATE 2 FAIL — bonding curve fetch error: ${err.message}`);
    stats.recordRejection('CURVE_FETCH_ERROR', { error: err.message });
    return FAIL('CURVE_FETCH_ERROR', err.message);
  }

  if (!curveData) {
    log.debug(`[${tag}] ❌ GATE 2 FAIL — token already graduated to Raydium`);
    stats.recordRejection('TOKEN_GRADUATED', {});
    return FAIL('TOKEN_GRADUATED', null);
  }

  const mcap = curveData.marketCapUSD;

  if (mcap === null || mcap === undefined || mcap === 0 || isNaN(mcap)) {
    log.warn(`[${tag}] ❌ GATE 2 FAIL — mcap is zero/null/NaN (fdv=0 bug guard)`);
    stats.recordRejection('MCAP_ZERO', { mcap });
    return FAIL('MCAP_ZERO', { mcap });
  }

  if (mcap < cfg.mcapMin || mcap > cfg.mcapMax) {
    const dir = mcap < cfg.mcapMin ? 'TOO LOW' : 'TOO HIGH';
    log.info(`[${tag}] ❌ GATE 2 FAIL — mcap $${mcap.toFixed(0)} ${dir} (window: $${cfg.mcapMin}-$${cfg.mcapMax})`);
    stats.recordRejection('MCAP_GATE', { mcap, dir });
    return FAIL('MCAP_GATE', { mcap, min: cfg.mcapMin, max: cfg.mcapMax });
  }
  log.debug(`[${tag}] ✅ Gate 2 — mcap $${mcap.toFixed(0)}`);

  // ── GATE 3: LIQUIDITY ──────────────────────────────────────────────────────
  const liq = curveData.liquidityUSD;
  if (!liq || liq < cfg.minLiquidityForBuy) {
    log.info(`[${tag}] ❌ GATE 3 FAIL — liquidity $${(liq||0).toFixed(0)} < $${cfg.minLiquidityForBuy}`);
    stats.recordRejection('LIQUIDITY_GATE', { liquidity: liq });
    return FAIL('LIQUIDITY_GATE', { liquidity: liq });
  }
  log.debug(`[${tag}] ✅ Gate 3 — liquidity $${liq.toFixed(0)}`);

  // ── GATE 4: RED FLAGS ──────────────────────────────────────────────────────
  const meta       = await getTokenMeta(mint).catch(() => ({}));
  const redFlags   = [];
  const greenFlags = [];

  if (meta.mintAuthorityRevoked === false) {
    redFlags.push('Mint authority NOT revoked ❌');
  } else {
    greenFlags.push('Mint authority revoked ✅');
  }

  if (meta.freezeAuthorityRevoked === false) {
    redFlags.push('Freeze authority NOT revoked ❌');
  } else {
    greenFlags.push('Freeze authority revoked ✅');
  }

  if (meta.hasTwitter)  greenFlags.push('Twitter ✅');
  if (meta.hasTelegram) greenFlags.push('Telegram ✅');
  if (meta.hasWebsite)  greenFlags.push('Website ✅');

  if (redFlags.length > 0) {
    log.info(`[${tag}] ❌ GATE 4 FAIL — red flags: ${redFlags.join(' | ')}`);
    stats.recordRejection('RED_FLAG', redFlags);
    return FAIL('RED_FLAG', redFlags);
  }
  log.debug(`[${tag}] ✅ Gate 4 — no red flags`);

  // ── GATE 5: WALLET CONCENTRATION ──────────────────────────────────────────
  const { top10Pct } = await getTopHolderConcentration(mint);
  const devHoldingPct = meta.devHoldingPct || 0;
  const devTxns       = meta.devTransactionCount || 0;

  if (top10Pct > cfg.maxWalletConcentration) {
    const overrideA = devHoldingPct < cfg.devMaxHoldingPct;
    const overrideB = devTxns === 0;

    if (!(overrideA && overrideB)) {
      log.info(`[${tag}] ❌ GATE 5 FAIL — top10 ${top10Pct.toFixed(1)}% > ${cfg.maxWalletConcentration}% | dev: ${devHoldingPct.toFixed(1)}% | devTxns: ${devTxns}`);
      stats.recordRejection('CONCENTRATION_GATE', { top10Pct, devHoldingPct, devTxns });
      return FAIL('CONCENTRATION_GATE', { top10Pct, devHoldingPct, devTxns });
    }
    log.debug(`[${tag}] ✅ Gate 5 — concentration override applied`);
    greenFlags.push(`Concentration override: dev ${devHoldingPct.toFixed(1)}% + 0 txns ✅`);
  } else {
    greenFlags.push(`Top 10 wallets: ${top10Pct.toFixed(1)}% ✅`);
  }

  // ── GATE 6: SCORE ──────────────────────────────────────────────────────────
  const tokenDataForScoring = {
    ticker:              meta.symbol       || mint.slice(0, 8),
    buySellRatio:        detection.buySellRatio      || 1,
    transactionCount:    detection.transactionCount  || 0,
    top10HolderPct:      top10Pct,
    liquidity:           liq,
    hasTwitter:          meta.hasTwitter   || false,
    hasTelegram:         meta.hasTelegram  || false,
    hasWebsite:          meta.hasWebsite   || false,
    devHoldingPct,
    devTransactionCount: devTxns,
  };

  const { score, breakdown } = scoreToken(tokenDataForScoring);

  if (score < cfg.minScore) {
    log.info(`[${tag}] ❌ GATE 6 FAIL — score ${score}/100 < ${cfg.minScore} | breakdown: BS=${breakdown.buySellRatio?.score} txns=${breakdown.transactionCount?.score} dist=${breakdown.top10HolderPct?.score} liq=${breakdown.liquidity?.score} social=${breakdown.social?.score} dev=${breakdown.dev?.score}`);
    stats.recordRejection('SCORE_GATE', { score, breakdown });
    return FAIL('SCORE_GATE', { score, breakdown });
  }

  stats.recordPass();
  log.info(`[${tag}] ✅✅✅ ALL GATES PASSED — score ${score}/100 mcap $${mcap.toFixed(0)}`);

  return PASS({
    mint,
    name:             meta.name    || 'Unknown',
    ticker:           meta.symbol  || mint.slice(0, 8),
    ageStr,
    ageMinutes,
    entryPrice:       curveData.priceUSD,
    entryMcap:        mcap,
    liquidity:        liq,
    score,
    buySellRatio:     detection.buySellRatio      || 1,
    transactionCount: detection.transactionCount  || 0,
    devHoldingPct,
    devTxns,
    top10Pct,
    greenFlags,
    redFlags,
    hasTwitter:       meta.hasTwitter  || false,
    hasTelegram:      meta.hasTelegram || false,
    hasWebsite:       meta.hasWebsite  || false,
    creator,
    detectionSignature: detection.signature,
    creationTime,
  });
}

module.exports = { evaluate };
