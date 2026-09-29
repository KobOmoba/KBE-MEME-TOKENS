/**
 * Tracker — Position Monitor Loop + Pre-Sign Refresh Loop
 *
 * Runs TWO of the three independent loops:
 *   Loop 2: Position Monitor (every 10s) — checks exits for all open positions
 *   Loop 3: Pre-Sign Refresh (every 45s) — rebuilds expiring pre-signed transactions
 *
 * TASK 1 (CRITICAL): 1.5x moon bag rule replaces the 999% stop loss workaround.
 *   - Stop loss ONLY fires when BOTH tier1Sold AND tier2Sold are true
 *   - Stop loss fires when currentMultiple < 1.5 (price fell back below 1.5x entry)
 *   - Before both tiers, ONLY the 15-minute time exit applies
 *   - This is the exact logic from the spec §7 and the task list
 *
 * TASK 6: Tier tracking flags (tier1Sold, tier2Sold, moonBagActive) are confirmed
 *   on every position and used as the conditions for the stop loss.
 *
 * PITFALL FIX #3: stopLossAlerted is reset on failed sell (in seller.js).
 *   We never set it permanently here — seller.js resets it if the tx fails.
 */

const cfg                    = require('../config');
const { getBondingCurveData } = require('./api/pumpfun');
const { buildAllPresignedSells } = require('./buyer');
const { executeSell }        = require('./seller');
const { savePositions }      = require('./utils/storage');
const log                    = require('./utils/logger').forTag('TRACKER');

// Shared positions map
let positions = new Map();

function init(posMap) {
  positions = posMap;
}

function getPositions() {
  return positions;
}

// ─── LOOP 2: Position Monitor ─────────────────────────────────────────────────
// Spec §4: Runs every 10 seconds. Never merged with the scanner loop.

let monitorBusy = false;

async function runMonitorCycle() {
  if (monitorBusy) return;
  monitorBusy = true;

  try {
    if (positions.size === 0) return;

    log.debug(`Monitor cycle: ${positions.size} open position(s)`);

    const checks = Array.from(positions.values()).map(pos => checkPosition(pos));
    await Promise.allSettled(checks);

    // Snapshot positions to disk for crash recovery
    savePositions(positions);

  } catch (err) {
    log.error('Monitor cycle error:', err.message);
  } finally {
    monitorBusy = false;
  }
}

// ─── Position check ───────────────────────────────────────────────────────────

async function checkPosition(pos) {
  let currentPrice = pos.currentPrice || pos.entryPrice;

  // Get live price from bonding curve (real-time on-chain data)
  try {
    const curve = await getBondingCurveData(pos.mint);
    if (curve) {
      currentPrice     = curve.priceUSD;
      pos.currentPrice = currentPrice;
    }
  } catch (err) {
    log.warn(`[${pos.ticker}] Price fetch failed — using last known $${currentPrice}`);
  }

  const currentMultiple = currentPrice / pos.entryPrice;
  pos.peakPrice = Math.max(pos.peakPrice || pos.entryPrice, currentPrice);   // ATH since entry

  log.debug(`[${pos.ticker}] ${currentMultiple.toFixed(3)}x @ $${currentPrice.toFixed(8)}`
    + ` | tier1=${pos.tier1Sold} tier2=${pos.tier2Sold}`);

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT RULE 1: TIME EXIT (15 minutes)
  // Spec §7 "Time-Based Exit — Overrides All Tiers"
  // Only applies if Tier 1 has NOT yet been hit.
  // ─────────────────────────────────────────────────────────────────────────
  if (!pos.tier1Sold && Date.now() > pos.timerExpiry) {
    log.info(`[${pos.ticker}] TIME EXIT — 15 min expired without reaching 2x`);
    await executeSell(pos, positions, 'TIME_EXIT', 100, currentPrice);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT RULE 2: TIER 1 — 2x → sell 50%
  // ─────────────────────────────────────────────────────────────────────────
  if (!pos.tier1Sold && currentMultiple >= cfg.tier1Multiple) {
    log.info(`[${pos.ticker}] TIER 1 — ${currentMultiple.toFixed(2)}x triggered (2x threshold)`);
    await executeSell(pos, positions, 'TIER1', cfg.tier1SellPct, currentPrice);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT RULE 3: TIER 2 — 4x → sell 30% (only after Tier 1)
  // ─────────────────────────────────────────────────────────────────────────
  if (pos.tier1Sold && !pos.tier2Sold && currentMultiple >= cfg.tier2Multiple) {
    log.info(`[${pos.ticker}] TIER 2 — ${currentMultiple.toFixed(2)}x triggered (4x threshold)`);
    await executeSell(pos, positions, 'TIER2', cfg.tier2SellPct, currentPrice);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT RULE 4: MOON BAG STOP LOSS — 1.5x floor (TASK 1 — REPLACES 999%)
  //
  // EXACT CONDITION from spec and task list:
  //   - Only fires when BOTH tier1Sold AND tier2Sold are true
  //   - currentMultiple must be BELOW 1.5 (price fell back from higher)
  //   - Sells the remaining 20% (the moon bag)
  //   - No stop loss before both tiers — only time exit handles early exits
  //
  // const currentMultiple = currentPrice / pos.entryPrice;  ← already calculated above
  // const tier1Done = pos.tier1Sold;
  // const tier2Done = pos.tier2Sold;
  // if (tier1Done && tier2Done && currentMultiple < 1.5) → FIRE
  // ─────────────────────────────────────────────────────────────────────────
  if (pos.tier1Sold && pos.tier2Sold) {
    const trail    = cfg.moonBagStopMode === 'trail';
    const stopPrice = trail
      ? pos.peakPrice * (1 - cfg.moonBagTrailPct / 100)      // 12% below ATH
      : pos.entryPrice * cfg.moonBagStopMultiple;            // legacy fixed floor
    if (currentPrice < stopPrice) {
      if (pos.stopLossAlerted) {
        log.debug(`[${pos.ticker}] Moon bag stop in flight (stopLossAlerted=true) — skipping`);
        return;
      }
      log.info(`[${pos.ticker}] MOON BAG STOP — ${currentMultiple.toFixed(2)}x`
             + (trail ? ` (ATH ${(pos.peakPrice / pos.entryPrice).toFixed(2)}x, trail ${cfg.moonBagTrailPct}%)`
                      : ` (below ${cfg.moonBagStopMultiple}x floor)`));
      pos.stopLossAlerted = true;
      // PITFALL FIX #3: seller.js resets stopLossAlerted=false if the sell fails => retry next cycle
      await executeSell(pos, positions, 'STOP_LOSS', cfg.moonBagPct, currentPrice);
      return;
    }
  }
}

// ─── LOOP 3: Pre-Sign Refresh ─────────────────────────────────────────────────
// Spec §8.1: Pre-signed transactions expire after ~60 seconds.
// We rebuild them every 45 seconds to keep them fresh.

const PRESIGN_MAX_AGE_MS = 55000; // Rebuild if older than 55 seconds
let presignBusy = false;

async function runPresignRefreshCycle() {
  if (presignBusy) return;
  presignBusy = true;

  try {
    for (const pos of positions.values()) {
      if (pos.paperTrade) continue; // Paper trades don't need pre-signed txs

      const builtAt = pos.presignedSells?.builtAt || 0;
      const age     = Date.now() - builtAt;

      if (age > PRESIGN_MAX_AGE_MS) {
        log.debug(`[${pos.ticker}] Refreshing pre-signed sells (age: ${(age/1000).toFixed(0)}s)`);
        try {
          pos.presignedSells = await buildAllPresignedSells(pos);
          log.debug(`[${pos.ticker}] Pre-signed sells refreshed`);
        } catch (err) {
          log.error(`[${pos.ticker}] Pre-sign refresh failed:`, err.message);
        }
      }
    }
  } catch (err) {
    log.error('Pre-sign refresh error:', err.message);
  } finally {
    presignBusy = false;
  }
}

module.exports = { init, getPositions, runMonitorCycle, runPresignRefreshCycle };
