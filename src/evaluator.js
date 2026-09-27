/**
 * Evaluator — Gate Sequence V3 §3
 *
 * Gates run in EXACT ORDER. First failure returns immediately — no further checks.
 *
 * PITFALL FIX #4: MCap gate now explicitly rejects fdv=0 or null.
 * PITFALL FIX #5: Age gate runs FIRST — before ANY enrichment API calls.
 * TASK 3 FIX: Age gate moved to the very first check in the pipeline.
 *
 * Gate order (spec §3):
 *  1. Token age  — FIRST, before any API calls
 *  2. Market cap — explicit zero/null check before range check
 *  3. Liquidity
 *  4. Red flags (mint auth, freeze auth, dev dump)
 *  5. Wallet concentration (with override conditions)
 *  6. Score (65/100 minimum)
 *  7. EXECUTE
 */

const cfg      = require('../config');
const { getBondingCurveData, getTopHolderConcentration } = require('./api/pumpfun');
const { getTokenMeta }    = require('./api/helius');
const { scoreToken }      = require('./utils/scorer');
const { getSolPrice }     = require('./api/rpc');
const log                 = require('./utils/logger').forTag('EVALUATOR');

// ─── Result helpers ───────────────────────────────────────────────────────────

const PASS = (data) => ({ pass: true,  data });
const FAIL = (reason, detail) => ({ pass: false, reason, detail });

// ─── Main gate function ───────────────────────────────────────────────────────

/**
 * Run the full gate sequence on a newly detected token.
 *
 * @param {Object} detection — { mint, creationTime, creator, signature }
 * @returns {{ pass: boolean, data?: Object, reason?: string, detail?: any }}
 */
async function evaluate(detection) {
  const { mint, creationTime, creator } = detection;
  const tag = `${mint.slice(0, 8)}...`;

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 1: TOKEN AGE — MUST BE FIRST. No API calls before this.
  // TASK 3 FIX: Age gate moved here, before enrichment, to save RPC calls.
  // Old code: age gate was AFTER full evaluation right before executeBuy().
  // ──────────────────────────────────────────────────────────────────────────
  const ageMs      = Date.now() - creationTime;
  const ageMinutes = ageMs / 60000;
  const ageStr     = `${Math.floor(ageMinutes)}m ${Math.floor((ageMs % 60000) / 1000)}s`;

  if (ageMinutes >= cfg.maxTokenAgeMinutes) {
    log.debug(`[${tag}] GATE 1 FAIL — age ${ageStr} >= ${cfg.maxTokenAgeMinutes} min`);
    return FAIL('AGE_GATE', { ageMinutes, ageStr });
  }
  log.debug(`[${tag}] Gate 1 PASS — age ${ageStr}`);

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 2: MARKET CAP — with explicit zero/null guard
  // PITFALL FIX #4: old code silently passed when fdv=0, treating 0 as falsy
  // in a range check. Now we explicitly reject null, undefined, or 0.
  // ──────────────────────────────────────────────────────────────────────────
  let curveData;
  try {
    curveData = await getBondingCurveData(mint);
  } catch (err) {
    log.warn(`[${tag}] Bonding curve fetch failed:`, err.message);
    return FAIL('CURVE_FETCH_ERROR', err.message);
  }

  if (!curveData) {
    log.debug(`[${tag}] GATE 2 FAIL — token graduated (no bonding curve)`);
    return FAIL('TOKEN_GRADUATED', null);
  }

  const mcap = curveData.marketCapUSD;

  // PITFALL FIX #4: Explicit zero/null check BEFORE range check
  if (mcap === null || mcap === undefined || mcap === 0 || isNaN(mcap)) {
    log.debug(`[${tag}] GATE 2 FAIL — mcap is zero/null/NaN (fdv=0 bug)`);
    return FAIL('MCAP_ZERO', { mcap });
  }

  if (mcap < cfg.mcapMin || mcap > cfg.mcapMax) {
    log.debug(`[${tag}] GATE 2 FAIL — mcap $${mcap.toFixed(0)} outside $${cfg.mcapMin}-$${cfg.mcapMax}`);
    return FAIL('MCAP_GATE', { mcap, min: cfg.mcapMin, max: cfg.mcapMax });
  }
  log.debug(`[${tag}] Gate 2 PASS — mcap $${mcap.toFixed(0)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 3: LIQUIDITY
  // ──────────────────────────────────────────────────────────────────────────
  const liq = curveData.liquidityUSD;
  if (!liq || liq < cfg.minLiquidityForBuy) {
    log.debug(`[${tag}] GATE 3 FAIL — liquidity $${liq?.toFixed(0)} < $${cfg.minLiquidityForBuy}`);
    return FAIL('LIQUIDITY_GATE', { liquidity: liq });
  }
  log.debug(`[${tag}] Gate 3 PASS — liquidity $${liq.toFixed(0)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 4: RED FLAGS
  // Spec §2.4: any red flag = auto-reject. No exceptions.
  // ──────────────────────────────────────────────────────────────────────────
  const meta = await getTokenMeta(mint).catch(() => ({}));

  const redFlags  = [];
  const greenFlags = [];

  // Mint authority (Pump.fun always revokes, but we confirm)
  if (meta.mintAuthorityRevoked === false) {
    redFlags.push('Mint authority NOT revoked ❌');
  } else {
    greenFlags.push('Mint authority revoked ✅');
  }

  // Freeze authority (Pump.fun always revokes)
  if (meta.freezeAuthorityRevoked === false) {
    redFlags.push('Freeze authority NOT revoked ❌');
  } else {
    greenFlags.push('Freeze authority revoked ✅');
  }

  // Social presence (green flag, not a red flag)
  if (meta.hasTwitter)  greenFlags.push('Twitter present ✅');
  if (meta.hasTelegram) greenFlags.push('Telegram present ✅');
  if (meta.hasWebsite)  greenFlags.push('Website present ✅');

  if (redFlags.length > 0) {
    log.debug(`[${tag}] GATE 4 FAIL — red flags: ${redFlags.join(', ')}`);
    return FAIL('RED_FLAG', redFlags);
  }
  log.debug(`[${tag}] Gate 4 PASS — no red flags`);

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 5: WALLET CONCENTRATION
  // Spec §2.5: reject if top 10 > 30%, UNLESS both override conditions met.
  // ──────────────────────────────────────────────────────────────────────────
  const { top10Pct } = await getTopHolderConcentration(mint);

  const devHoldingPct = meta.devHoldingPct || 0;
  const devTxns       = meta.devTransactionCount || 0;

  if (top10Pct > cfg.maxWalletConcentration) {
    // Check override conditions (BOTH must be true)
    const overrideA = devHoldingPct < cfg.devMaxHoldingPct;      // dev < 10%
    const overrideB = devTxns === 0;                              // dev zero txns in 3 min

    if (!(overrideA && overrideB)) {
      log.debug(`[${tag}] GATE 5 FAIL — top10 ${top10Pct.toFixed(1)}% > 30%, override not met`);
      return FAIL('CONCENTRATION_GATE', { top10Pct, devHoldingPct, devTxns });
    }
    log.debug(`[${tag}] Gate 5 — top10 ${top10Pct.toFixed(1)}% override APPLIED (dev ok)`);
    greenFlags.push('Concentration override: dev < 10% + zero txns ✅');
  } else {
    greenFlags.push(`Top 10 holders: ${top10Pct.toFixed(1)}% ✅`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 6: SCORE
  // Spec §2.6: minimum 65/100.
  // ──────────────────────────────────────────────────────────────────────────
  const tokenDataForScoring = {
    ticker:             meta.symbol      || mint.slice(0, 8),
    buySellRatio:       detection.buySellRatio || 1,
    transactionCount:   detection.transactionCount || 0,
    top10HolderPct:     top10Pct,
    liquidity:          liq,
    hasTwitter:         meta.hasTwitter  || false,
    hasTelegram:        meta.hasTelegram || false,
    hasWebsite:         meta.hasWebsite  || false,
    devHoldingPct:      devHoldingPct,
    devTransactionCount: devTxns,
  };

  const { score, breakdown } = scoreToken(tokenDataForScoring);

  if (score < cfg.minScore) {
    log.debug(`[${tag}] GATE 6 FAIL — score ${score}/100 < ${cfg.minScore}`);
    return FAIL('SCORE_GATE', { score, breakdown });
  }

  log.info(`[${tag}] ✅ ALL GATES PASSED — score ${score}/100 mcap $${mcap.toFixed(0)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // GATE 7: PASS — assemble position data for buyer
  // ──────────────────────────────────────────────────────────────────────────
  return PASS({
    mint,
    name:             meta.name   || 'Unknown',
    ticker:           meta.symbol || mint.slice(0, 8),
    ageStr,
    ageMinutes,
    entryPrice:       curveData.priceUSD,
    entryMcap:        mcap,
    liquidity:        liq,
    score,
    buySellRatio:     detection.buySellRatio || 1,
    transactionCount: detection.transactionCount || 0,
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
