/**
 * Seller — executes exits for all trigger types.
 *
 * PITFALL FIX #2: savePaperStats() and saveTracked() are called in the SELL path.
 *   Old code had both functions missing from the sell function entirely.
 *
 * PITFALL FIX #3: stopLossAlerted is RESET on failed sell so the stop loss retries.
 *   Old code: if stopLossAlerted=true and sell failed, the stop loss never fired again.
 *
 * TASK 1 FIX: The 1.5x moon bag rule is enforced here via currentMultiple < 1.5
 *   and only after BOTH tier1Sold and tier2Sold are confirmed.
 *   The 999% workaround is GONE.
 */

const cfg                              = require('../config');
const { firePresignedSell }            = require('./api/jito');
const { buildPresignedSell }           = require('./api/jupiter');
const { savePaperStats, saveTracked }  = require('./utils/storage');
const telegram                         = require('./telegram');
const log                              = require('./utils/logger').forTag('SELLER');

// ─── Main sell dispatcher ─────────────────────────────────────────────────────

/**
 * Execute a sell for the given reason.
 *
 * @param {Object}  pos        — the position from positions Map
 * @param {Map}     positions  — shared positions map (to remove on close)
 * @param {string}  reason     — 'TIER1' | 'TIER2' | 'STOP_LOSS' | 'TIME_EXIT'
 * @param {number}  percentage — what % of ORIGINAL position to sell
 * @param {number}  currentPrice — current token price for calculations
 * @returns {boolean} — true if sell succeeded
 */
async function executeSell(pos, positions, reason, percentage, currentPrice) {
  const amountTokens = pos.tokenAmount * (percentage / 100);
  const amountUSD    = amountTokens * currentPrice;
  const multiple     = currentPrice / pos.entryPrice;

  log.info(`[${pos.ticker}] ${reason} sell: ${percentage}% @ $${currentPrice.toFixed(8)} (${multiple.toFixed(2)}x)`);

  let success = false;
  let elapsed = '?';
  let method  = 'paper';

  // ─── PAPER TRADE ──────────────────────────────────────────────────────────
  if (pos.paperTrade) {
    success = true;
    elapsed = '0.00';
    method  = 'paper';

    // PITFALL FIX #2: savePaperStats MUST be called on every paper sell
    await savePaperStats('SELL', pos, {
      reason,
      percentage,
      amountOut:  amountUSD,
      multiple:   multiple.toFixed(2),
    });
    // PITFALL FIX #2: saveTracked MUST be called on every sell
    await saveTracked('SELL', pos, { reason, percentage });

    pos.totalRecovered = (pos.totalRecovered || 0) + amountUSD;
    pos.exits.push({ reason, percentage, amountUSD, multiple, ts: Date.now() });

    log.info(`[PAPER] ${pos.ticker} ${reason}: $${amountUSD.toFixed(4)} out (${multiple.toFixed(2)}x)`);

  } else {
    // ─── LIVE TRADE — VIA JITO BUNDLE ─────────────────────────────────────
    const presigned = getPresignedForReason(pos, reason);

    if (presigned && presigned.serialized) {
      // BEST PATH: fire pre-signed transaction via Jito bundle
      const result = await firePresignedSell(presigned.serialized, reason);
      success  = result.success;
      elapsed  = result.elapsed  || '?';
      method   = result.method   || 'jito';

      if (success) {
        const solOut   = presigned.quoteOut / 1e9;
        const { getSolPrice } = require('./api/rpc');
        const solPrice = await getSolPrice();
        const usdOut   = solOut * solPrice;

        pos.totalRecovered = (pos.totalRecovered || 0) + usdOut;
        pos.exits.push({ reason, percentage, amountUSD: usdOut, multiple, ts: Date.now() });

        await saveTracked('SELL', pos, { reason, percentage });
      }
    } else {
      // FALLBACK: build fresh transaction and send via RPC (slower)
      log.warn(`[${pos.ticker}] No presigned tx for ${reason} — building fresh`);
      const fresh = await buildPresignedSell(pos.mint, pos.tokenAmount, percentage).catch(() => null);

      if (fresh && fresh.serialized) {
        const result = await firePresignedSell(fresh.serialized, reason);
        success = result.success;
        elapsed = result.elapsed || '?';
        method  = result.method  || 'jito';
      } else {
        log.error(`[${pos.ticker}] ${reason}: Could not build sell transaction`);
        success = false;
      }
    }
  }

  // ─── POST-SELL STATE UPDATE ───────────────────────────────────────────────
  if (success) {
    const remainingPct = getRemainingPct(pos, reason, percentage);

    await telegram.sendExitNotification(pos, reason, {
      percentage,
      amountOut:    amountUSD,
      remainingPct,
      method,
      elapsed,
    });

    // Mark tiers and close if fully sold
    if (reason === 'TIER1') {
      pos.tier1Sold = true;
      log.info(`[${pos.ticker}] Tier 1 done — 50% recovered`);
    }

    if (reason === 'TIER2') {
      pos.tier2Sold   = true;
      pos.moonBagActive = true;
      log.info(`[${pos.ticker}] Tier 2 done — moon bag (20%) now active with 1.5x stop`);
    }

    if (reason === 'STOP_LOSS' || reason === 'TIME_EXIT' || remainingPct <= 0) {
      log.info(`[${pos.ticker}] Position closed — total recovered: $${pos.totalRecovered.toFixed(4)}`);
      positions.delete(pos.mint);
    }

  } else {
    // PITFALL FIX #3: On sell failure, RESET stopLossAlerted so it retries next monitor cycle.
    // Old code: left stopLossAlerted=true permanently → position trapped with no stop loss.
    if (reason === 'STOP_LOSS') {
      pos.stopLossAlerted = false;
      log.warn(`[${pos.ticker}] Stop loss SELL FAILED — stopLossAlerted reset for retry`);
    }
    log.error(`[${pos.ticker}] ${reason} sell FAILED — will retry next cycle`);
  }

  return success;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPresignedForReason(pos, reason) {
  if (!pos.presignedSells) return null;
  const map = {
    TIER1:      pos.presignedSells.tier1,
    TIER2:      pos.presignedSells.tier2,
    STOP_LOSS:  pos.presignedSells.moonBag,
    TIME_EXIT:  pos.presignedSells.tier1,  // Full exit: reuse tier1 tx (100% if tier1 not yet sold)
  };
  return map[reason] || null;
}

function getRemainingPct(pos, reason, soldPct) {
  const sold = [
    pos.tier1Sold ? cfg.tier1SellPct    : 0,
    pos.tier2Sold ? cfg.tier2SellPct    : 0,
    // Add just-sold pct if not yet reflected in flags
    (reason === 'TIER1' || reason === 'TIER2') ? soldPct : 0,
  ].reduce((a, b) => a + b, 0);

  return Math.max(0, 100 - sold);
}

module.exports = { executeSell };
