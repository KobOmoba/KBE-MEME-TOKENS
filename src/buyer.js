/**
 * Buyer — executes a buy after all gates pass.
 *
 * PITFALL FIX #1: paperTrade flag is explicitly set on the position object here.
 *   Old code never propagated the config flag into each position.
 *   Now: every position carries pos.paperTrade and ALL downstream sell checks use it.
 *
 * PITFALL FIX #6: executeBuy is no longer gated on autoTradeEnabled for paper trades.
 *   Old code: if (!autoTradeEnabled) return; — this blocked paper buys.
 *   Now: paper path and live path are completely separate branches.
 *
 * PITFALL FIX #2: savePaperStats() and saveTracked() are both called in the BUY path.
 */

const cfg              = require('../config');
const { getSolPrice }  = require('./api/rpc');
const { executeBuySwap, buildPresignedSell } = require('./api/jupiter');
const { savePaperStats, saveTracked }        = require('./utils/storage');
const telegram                               = require('./telegram');
const log                                    = require('./utils/logger').forTag('BUYER');

// Shared positions map — passed in from tracker.js
let positions = null;

function init(posMap) {
  positions = posMap;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Execute a buy for a token that has passed all gates.
 *
 * @param {Object} tokenData — assembled by evaluator.js on gate pass
 * @returns {Object|null} position object, or null on failure
 */
async function executeBuy(tokenData) {
  // Dedup guard — don't buy the same token twice
  if (positions && positions.has(tokenData.mint)) {
    log.warn(`Already hold ${tokenData.ticker} — skipping duplicate buy`);
    return null;
  }

  if (cfg.paperTrade) {
    return await executePaperBuy(tokenData);
  }

  // ─── LIVE TRADING CHECK ─────────────────────────────────────────────────
  // PITFALL FIX #6: autoTradeEnabled guard only applies to LIVE trades.
  // Paper trades never reach this block.
  if (!cfg.autoTradeEnabled) {
    log.warn(`autoTradeEnabled=false — live buy suppressed for ${tokenData.ticker}`);
    return null;
  }

  return await executeLiveBuy(tokenData);
}

// ─── Paper buy ────────────────────────────────────────────────────────────────

async function executePaperBuy(tokenData) {
  log.info(`[PAPER] Buying ${tokenData.ticker} @ $${tokenData.entryPrice}`);

  // V4.2 paper realism: fill at a slightly WORSE price than the evaluated one, and pay the buy fee
  const fillPrice = tokenData.entryPrice * (1 + cfg.paperSlippageBps / 10000);
  const solPrice  = await getSolPrice();
  const buyFeeUSD = (cfg.priorityFeeBuy / 1e9) * solPrice;
  const position = buildPosition(tokenData, true, {   // PITFALL FIX #1: paperTrade=true explicitly
    entryPrice:  fillPrice,
    tokenAmount: cfg.tradeSize / fillPrice,
  });
  position.paperFeesUSD = buyFeeUSD;

  positions.set(tokenData.mint, position);

  // PITFALL FIX #2: savePaperStats called in BUY path
  await savePaperStats('BUY', position, {
    entryPrice: position.entryPrice,
    amountIn:   position.amountUSD,
    feeUSD:     buyFeeUSD,
  });
  // PITFALL FIX #2: saveTracked called in BUY path
  await saveTracked('BUY', position);

  // Telegram notification (paper mode flag visible to operator)
  await telegram.sendBuyConfirmation(position);

  log.info(`[PAPER] Position opened: ${position.ticker} #${position.id}`);
  return position;
}

// ─── Live buy ─────────────────────────────────────────────────────────────────

async function executeLiveBuy(tokenData) {
  log.info(`[LIVE] Buying ${tokenData.ticker} @ $${tokenData.entryPrice}`);

  let swapResult;
  try {
    swapResult = await executeBuySwap(tokenData.mint, cfg.tradeSize);
  } catch (err) {
    log.error(`Live buy failed for ${tokenData.ticker}:`, err.message);
    await telegram.sendAlert('BUY FAILED', `${tokenData.ticker}: ${err.message}`);
    return null;
  }

  if (!swapResult) {
    log.error(`Live buy returned null for ${tokenData.ticker}`);
    return null;
  }

  // Use the actual execution price, not the quoted price
  const position = buildPosition(tokenData, false, {
    entryPrice:    swapResult.priceUSD,
    tokenAmount:   swapResult.tokensReceived,
    txSignature:   swapResult.txSignature,
  });

  positions.set(tokenData.mint, position);

  // Build and store pre-signed sells immediately after buy confirmation
  // Spec §8.1: pre-signed sells are ready BEFORE the operator notification
  position.presignedSells = await buildAllPresignedSells(position).catch(err => {
    log.error('Pre-sign build failed:', err.message);
    return null;
  });

  await saveTracked('BUY', position);

  // Telegram notification with pre-sign status
  await telegram.sendBuyConfirmation(position);

  log.info(`[LIVE] Position opened: ${position.ticker} @ $${position.entryPrice}`);
  return position;
}

// ─── Position builder ─────────────────────────────────────────────────────────

let _posCounter = 0;

function buildPosition(tokenData, isPaper, overrides = {}) {
  _posCounter++;
  return {
    id:               `POS-${_posCounter}`,
    mint:             tokenData.mint,
    name:             tokenData.name,
    ticker:           tokenData.ticker,
    ageStr:           tokenData.ageStr,

    // PITFALL FIX #1: paperTrade is explicitly set from the argument, not the config.
    // This means even if config changes mid-session, open positions retain their mode.
    paperTrade:       isPaper,

    // Pricing
    entryPrice:       overrides.entryPrice    || tokenData.entryPrice,
    entryMcap:        tokenData.entryMcap,
    currentPrice:     overrides.entryPrice    || tokenData.entryPrice,

    // Position size
    amountUSD:        cfg.tradeSize,
    tokenAmount:      overrides.tokenAmount   || (cfg.tradeSize / tokenData.entryPrice),

    // Entry metadata
    entryTime:        Date.now(),
    timerExpiry:      Date.now() + (cfg.maxHoldMinutes * 60 * 1000),
    txSignature:      overrides.txSignature   || null,

    // TASK 6: Tier tracking flags — required for the 1.5x moon bag rule (Task 1)
    tier1Sold:        false,    // Set when 50% sold at 2x
    tier2Sold:        false,    // Set when 30% sold at 4x
    moonBagActive:    false,    // Set when BOTH tier1Sold and tier2Sold are true

    // PITFALL FIX #3: stopLossAlerted is reset on failed sell (in tracker.js)
    stopLossAlerted:  false,

    // Pre-signed sells (populated after live buy)
    presignedSells:   null,

    // Exit tracking
    totalRecovered:   0,
    exits:            [],

    // Token metadata for display
    score:            tokenData.score,
    liquidity:        tokenData.liquidity,
    buySellRatio:     tokenData.buySellRatio,
    transactionCount: tokenData.transactionCount,
    devHoldingPct:    tokenData.devHoldingPct,
    devTxns:          tokenData.devTxns,
    top10Pct:         tokenData.top10Pct,
    greenFlags:       tokenData.greenFlags    || [],
    redFlags:         tokenData.redFlags      || [],
    creator:          tokenData.creator       || null,
  };
}

// ─── Pre-sign all three exits ─────────────────────────────────────────────────

async function buildAllPresignedSells(position) {
  if (cfg.paperTrade) return null; // Not needed for paper trades

  log.info(`Building pre-signed sells for ${position.ticker}...`);

  const [tier1, tier2, moonBag] = await Promise.allSettled([
    buildPresignedSell(position.mint, position.tokenAmount, cfg.tier1SellPct),
    buildPresignedSell(position.mint, position.tokenAmount, cfg.tier2SellPct),
    buildPresignedSell(position.mint, position.tokenAmount, cfg.moonBagPct),
  ]);

  const result = {
    tier1:    tier1.status === 'fulfilled'  ? tier1.value   : null,
    tier2:    tier2.status === 'fulfilled'  ? tier2.value   : null,
    moonBag:  moonBag.status === 'fulfilled' ? moonBag.value : null,
    builtAt:  Date.now(),
  };

  log.info(`Pre-signed: tier1=${!!result.tier1} tier2=${!!result.tier2} moonBag=${!!result.moonBag}`);
  return result;
}

module.exports = { init, executeBuy, buildAllPresignedSells };
