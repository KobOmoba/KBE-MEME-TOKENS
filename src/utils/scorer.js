/**
 * Scorer — token score out of 100.  (V4.2)
 *
 * V4.2 FIXES
 *  - Old code used `x || fallback`, which turned a legitimate 0 (dev holds 0%, dev made 0 txns)
 *    into 100 / 999 — the WORST value. Perfect dev behaviour scored 0 points.
 *  - Inputs that are unknown (null) are now EXCLUDED and the score is scaled to /100 over the
 *    components we could actually measure, instead of silently scoring them as 0.
 *    `scaled:true` is returned so the caller can flag it. (Old evaluator never supplied buy/sell
 *    ratio or txn count at all: max possible score was 45/100, so the 65 gate could never pass.)
 */

const log = require('./logger').forTag('SCORER');

function scoreToken(t) {
  const breakdown = {};
  let total = 0, max = 0;

  // 1. Buy/Sell ratio (25) — needs the trade feed
  if (t.buySellRatio != null) {
    const r = t.buySellRatio;
    const s = r >= 4 ? 25 : r >= 3 ? 20 : r >= 2 ? 15 : r >= 1.5 ? 8 : 0;
    breakdown.buySellRatio = { ratio: r.toFixed(2), score: s };
    total += s; max += 25;
  } else breakdown.buySellRatio = { ratio: 'n/a', score: null };

  // 2. Transaction count (20)
  if (t.transactionCount != null) {
    const n = t.transactionCount;
    const s = n >= 300 ? 20 : n >= 150 ? 15 : n >= 75 ? 10 : n >= 30 ? 5 : 0;
    breakdown.transactionCount = { count: n, score: s };
    total += s; max += 20;
  } else breakdown.transactionCount = { count: 'n/a', score: null };

  // 3. Holder distribution (20) — bonding curve already excluded upstream
  if (t.top10HolderPct != null) {
    const p = t.top10HolderPct;
    const s = p < 10 ? 20 : p < 15 ? 15 : p < 20 ? 10 : p < 25 ? 5 : 0;
    breakdown.top10HolderPct = { pct: p.toFixed(1), score: s };
    total += s; max += 20;
  } else breakdown.top10HolderPct = { pct: 'n/a', score: null };

  // 4. Liquidity depth (15)
  const liq = t.liquidity || 0;
  const liqS = liq >= 30000 ? 15 : liq >= 20000 ? 10 : liq >= 15000 ? 7 : liq >= 10000 ? 4 : 0;
  breakdown.liquidity = { usd: liq.toFixed(0), score: liqS };
  total += liqS; max += 15;

  // 5. Social presence (10)
  const soc = [t.hasTwitter, t.hasTelegram, t.hasWebsite].filter(Boolean).length;
  const socS = soc === 3 ? 10 : soc === 2 ? 6 : soc === 1 ? 3 : 0;
  breakdown.social = { count: soc, score: socS };
  total += socS; max += 10;

  // 6. Dev behaviour (10) — needs BOTH dev holding % and dev txn count to be known
  if (t.devHoldingPct != null && t.devTransactionCount != null) {
    const pct = t.devHoldingPct, tx = t.devTransactionCount;
    const s = (pct < 5 && tx === 0) ? 10 : (pct < 10 && tx === 0) ? 7 : tx === 0 ? 3 : 0;
    breakdown.dev = { holdingPct: pct.toFixed(1), txns: tx, score: s };
    total += s; max += 10;
  } else breakdown.dev = { holdingPct: 'n/a', txns: 'n/a', score: null };

  const scaled = max < 100;
  const score = max > 0 ? Math.min(100, Math.round((total / max) * 100)) : 0;
  log.debug(`Score ${t.ticker || ''}: ${score}/100 (raw ${total}/${max})`, breakdown);
  return { score, raw: total, max, scaled, breakdown };
}

module.exports = { scoreToken };
