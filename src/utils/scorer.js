/**
 * Scorer — token scoring out of 100.
 *
 * Spec §2.6: minimum 65/100. 65 with clean red flags beats 80 with one red flag.
 * This is only reached AFTER the hard gates (age, mcap, liquidity, red flags).
 * Scoring is the LAST gate before buy.
 */

const log = require('./logger').forTag('SCORER');

/**
 * Score a token 0-100 based on available on-chain and market data.
 * Returns { score: Number, breakdown: Object }
 *
 * @param {Object} t — enriched token data
 */
function scoreToken(t) {
  const breakdown = {};
  let total = 0;

  // ─── 1. Buy/Sell Ratio (25 pts) ───────────────────────────────────────────
  // Strong buy pressure is the strongest leading indicator for meme moves.
  const bsRatio = t.buySellRatio || 0;
  let bsScore = 0;
  if      (bsRatio >= 4)   bsScore = 25;
  else if (bsRatio >= 3)   bsScore = 20;
  else if (bsRatio >= 2)   bsScore = 15;
  else if (bsRatio >= 1.5) bsScore = 8;
  else                     bsScore = 0;
  breakdown.buySellRatio = { ratio: bsRatio.toFixed(2), score: bsScore };
  total += bsScore;

  // ─── 2. Transaction count (20 pts) ────────────────────────────────────────
  // More txns = more participants = less likely to be a dev wash.
  const txns = t.transactionCount || 0;
  let txScore = 0;
  if      (txns >= 300) txScore = 20;
  else if (txns >= 150) txScore = 15;
  else if (txns >= 75)  txScore = 10;
  else if (txns >= 30)  txScore = 5;
  else                  txScore = 0;
  breakdown.transactionCount = { count: txns, score: txScore };
  total += txScore;

  // ─── 3. Holder distribution (20 pts) ──────────────────────────────────────
  // Lower concentration = healthier token. Gate already blocked above 30%.
  const top10Pct = t.top10HolderPct || 100;
  let distScore = 0;
  if      (top10Pct < 10) distScore = 20;
  else if (top10Pct < 15) distScore = 15;
  else if (top10Pct < 20) distScore = 10;
  else if (top10Pct < 25) distScore = 5;
  else                    distScore = 0;   // 25-30%: gate already passed but low score
  breakdown.top10HolderPct = { pct: top10Pct.toFixed(1), score: distScore };
  total += distScore;

  // ─── 4. Liquidity depth (15 pts) ──────────────────────────────────────────
  // More liquidity above the $10k minimum = safer exit.
  const liq = t.liquidity || 0;
  let liqScore = 0;
  if      (liq >= 30000) liqScore = 15;
  else if (liq >= 20000) liqScore = 10;
  else if (liq >= 15000) liqScore = 7;
  else if (liq >= 10000) liqScore = 4;   // At the gate minimum
  else                   liqScore = 0;   // Should never reach here (gate blocks)
  breakdown.liquidity = { usd: liq.toFixed(0), score: liqScore };
  total += liqScore;

  // ─── 5. Social presence (10 pts) ──────────────────────────────────────────
  const socialCount = [t.hasTwitter, t.hasTelegram, t.hasWebsite].filter(Boolean).length;
  let socialScore = 0;
  if      (socialCount === 3) socialScore = 10;
  else if (socialCount === 2) socialScore = 6;
  else if (socialCount === 1) socialScore = 3;
  breakdown.social = { count: socialCount, score: socialScore };
  total += socialScore;

  // ─── 6. Dev wallet behaviour (10 pts) ─────────────────────────────────────
  const devPct  = t.devHoldingPct || 100;
  const devTxns = t.devTransactionCount || 999;
  let devScore  = 0;
  if (devPct < 5 && devTxns === 0)  devScore = 10;
  else if (devPct < 10 && devTxns === 0) devScore = 7;
  else if (devTxns === 0)           devScore = 3;
  breakdown.dev = { holdingPct: devPct.toFixed(1), txns: devTxns, score: devScore };
  total += devScore;

  // Cap at 100
  total = Math.min(100, total);

  log.debug(`Score for ${t.ticker || t.mint?.slice(0, 8)}: ${total}/100`, breakdown);

  return { score: total, breakdown };
}

module.exports = { scoreToken };
