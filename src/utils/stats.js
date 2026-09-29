/**
 * Stats — tracks every token detection and rejection reason.
 * Gives Bayo visibility from Telegram on why tokens are not qualifying.
 */

const stats = {
  sessionStart:   Date.now(),
  totalDetected:  0,
  totalPassed:    0,
  enteredWindow:  0,
  watching:       0,
  peaks:          [],
  rejections: {
    AGE_GATE:          { count: 0, label: 'Too old (>5 min)',          examples: [] },
    MCAP_ZERO:         { count: 0, label: 'MCap is zero/null (fdv=0)', examples: [] },
    MCAP_TOO_LOW:      { count: 0, label: 'Never reached $25k mcap',   examples: [] },
    MCAP_TOO_HIGH:     { count: 0, label: 'Jumped above $35k',         examples: [] },
    HOLDER_FETCH_ERROR:{ count: 0, label: 'Holder data unavailable',   examples: [] },
    WATCHLIST_FULL:    { count: 0, label: 'Watchlist full (dropped)',  examples: [] },
    MCAP_GATE:         { count: 0, label: 'MCap outside $25k-$35k',    examples: [] },
    LIQUIDITY_GATE:    { count: 0, label: 'Liquidity below $10k',      examples: [] },
    RED_FLAG:          { count: 0, label: 'Red flag detected',          examples: [] },
    CONCENTRATION_GATE:{ count: 0, label: 'Wallet concentration >30%', examples: [] },
    SCORE_GATE:        { count: 0, label: 'Score below 65/100',        examples: [] },
    CURVE_FETCH_ERROR: { count: 0, label: 'Bonding curve fetch failed', examples: [] },
    TOKEN_GRADUATED:   { count: 0, label: 'Token already on Raydium',  examples: [] },
  },
};

function recordDetection() {
  stats.totalDetected++;
}

function recordRejection(reason, detail = {}) {
  if (!stats.rejections[reason]) {
    stats.rejections[reason] = { count: 0, label: reason, examples: [] };
  }
  stats.rejections[reason].count++;
  if (detail && detail.peak > 0) { stats.peaks.push(detail.peak); if (stats.peaks.length > 500) stats.peaks.shift(); }

  // Keep last 3 examples for each rejection type
  const example = buildExample(reason, detail);
  if (example) {
    stats.rejections[reason].examples.push(example);
    if (stats.rejections[reason].examples.length > 3) {
      stats.rejections[reason].examples.shift();
    }
  }
}

function recordWindowEntry() { stats.enteredWindow++; }
function setWatching(n) { stats.watching = n; }

function recordPass() {
  stats.totalPassed++;
}

function buildExample(reason, detail) {
  switch (reason) {
    case 'AGE_GATE':
      return detail.ageStr ? `age=${detail.ageStr}` : null;
    case 'MCAP_TOO_LOW':
      return detail.peak ? `peak=$${Math.round(detail.peak).toLocaleString()}` : null;
    case 'MCAP_TOO_HIGH':
      return detail.mcap ? `mcap=$${Math.round(detail.mcap).toLocaleString()}` : null;
    case 'MCAP_GATE':
      return detail.mcap ? `mcap=$${Math.round(detail.mcap).toLocaleString()}` : null;
    case 'MCAP_ZERO':
      return 'mcap=0 or null';
    case 'LIQUIDITY_GATE':
      return detail.liquidity ? `liq=$${Math.round(detail.liquidity).toLocaleString()}` : null;
    case 'RED_FLAG':
      return Array.isArray(detail) ? detail[0] : null;
    case 'CONCENTRATION_GATE':
      return detail.top10Pct ? `top10=${detail.top10Pct.toFixed(1)}%` : null;
    case 'SCORE_GATE':
      return detail.score ? `score=${detail.score}/100` : null;
    default:
      return null;
  }
}

function getSummary() {
  const uptimeMin  = Math.floor((Date.now() - stats.sessionStart) / 60000);
  const uptimeHrs  = (uptimeMin / 60).toFixed(1);
  const totalRej   = stats.totalDetected - stats.totalPassed;
  const passRate   = stats.totalDetected > 0
    ? ((stats.totalPassed / stats.totalDetected) * 100).toFixed(1)
    : '0.0';

  const rejLines = Object.entries(stats.rejections)
    .filter(([_, v]) => v.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([_, v]) => {
      const pct      = stats.totalDetected > 0
        ? ((v.count / stats.totalDetected) * 100).toFixed(0)
        : '0';
      const examples = v.examples.length > 0 ? ` (${v.examples.slice(-2).join(', ')})` : '';
      return `  ${v.label}: ${v.count} (${pct}%)${examples}`;
    })
    .join('\n');

  const pk = [...stats.peaks].sort((a, b) => a - b);
  const q = (f) => pk.length ? '$' + Math.round(pk[Math.min(pk.length - 1, Math.floor(pk.length * f))]).toLocaleString() : 'n/a';
  const extraLines = [
    `  Watching now: ${stats.watching}`,
    `  Entered $25k-$35k window: ${stats.enteredWindow}`,
    `  Peak mcap of finished tokens: median ${q(0.5)} | p90 ${q(0.9)} | max ${q(0.999)}`,
  ].join('\n');

  return {
    extraLines,
    uptimeHrs,
    totalDetected: stats.totalDetected,
    totalPassed:   stats.totalPassed,
    totalRejected: totalRej,
    passRate,
    rejLines: rejLines || '  None yet',
  };
}

function reset() {
  stats.sessionStart = Date.now();
  stats.totalDetected = 0;
  stats.totalPassed = 0;
  stats.enteredWindow = 0;
  stats.peaks = [];
  for (const key of Object.keys(stats.rejections)) {
    stats.rejections[key].count = 0;
    stats.rejections[key].examples = [];
  }
}

module.exports = { recordWindowEntry, setWatching, recordDetection, recordRejection, recordPass, getSummary, reset };
