#!/usr/bin/env node
/**
 * Analyse data/watch_log.jsonl — answers "what would have happened?" from REAL token paths.
 *   node scripts/analyze.js [path]
 *
 * CAVEATS (printed in the report too): trajectories are sampled every ~9s (30s for shadow
 * tokens), so fast dumps between samples are invisible => results are OPTIMISTIC.
 * Gross of fees. Entry slippage 5% assumed.
 */
const fs = require('fs');
const file = process.argv[2] || './data/watch_log.jsonl';
const rows = [];
for (const f of [file + '.1', file]) if (fs.existsSync(f))
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach(l => { try { rows.push(JSON.parse(l)); } catch (_) {} });
if (!rows.length) { console.log('No data yet: ' + file); process.exit(0); }

const SLIP = 1.05, MIN = 25000, MAX = 35000, TRAIL = 0.12;
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';

// Replay the bot's exit rules on one sampled path from index i (entry mcap = path[i].mcap * slippage)
function simulate(path, i, timeExitSec = 900) {
  const entry = path[i][1] * SLIP; let t1 = false, t2 = false, peak = entry, out = 0, rem = 1;
  for (let j = i + 1; j < path.length; j++) {
    const [age, m] = path[j], x = m / entry; peak = Math.max(peak, m);
    if (!t1 && age - path[i][0] > timeExitSec) { out += rem * x; return { pnl: out - 1, end: 'time', mult: x }; }
    if (!t1 && x >= 2) { out += 0.5 * 2; rem -= 0.5; t1 = true; }
    if (t1 && !t2 && x >= 4) { out += 0.3 * 4; rem -= 0.3; t2 = true; }
    if (t1 && t2 && m < peak * (1 - TRAIL)) { out += rem * x; return { pnl: out - 1, end: 'trail', mult: x }; }
  }
  const last = path[path.length - 1][1] / entry;            // data ended before an exit fired (censored)
  out += rem * last; return { pnl: out - 1, end: 'open', mult: last, t1, t2 };
}
function report(name, list) {
  if (!list.length) return console.log(`\n${name}: no tokens`);
  const r = list.map(([p, i]) => simulate(p, i));
  const w = r.filter(x => x.pnl > 0).length, t1 = r.filter(x => x.t1 || x.end === 'trail').length;
  const avg = r.reduce((a, x) => a + x.pnl, 0) / r.length;
  console.log(`\n${name}: ${list.length} tokens | reached 2x: ${pct(t1, r.length)} | profitable: ${pct(w, r.length)} | avg gross P&L per $1: ${avg >= 0 ? '+' : ''}${avg.toFixed(3)} | unresolved at end of data: ${pct(r.filter(x => x.end === 'open').length, r.length)}`);
}

console.log(`Tokens logged: ${rows.length}  (${rows.filter(r => r.feed).length} with trade feed)`);
const peaks = rows.map(r => r.peakMcap).filter(Boolean).sort((a, b) => a - b);
const q = f => '$' + (peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * f))] || 0).toLocaleString();
console.log(`Peak mcap: median ${q(.5)} | p90 ${q(.9)} | p99 ${q(.99)}`);
const ge = v => rows.filter(r => r.peakMcap >= v).length;
console.log(`Reached >=$10k: ${pct(ge(1e4), rows.length)} | >=$25k: ${pct(ge(25000), rows.length)} | >=$35k: ${pct(ge(35000), rows.length)} | >=$60k: ${pct(ge(6e4), rows.length)} | graduated: ${pct(rows.filter(r => r.gradAgeSec != null).length, rows.length)}`);

// A. "Buy at ~$0": enter at the FIRST sample of every token, no filters at all
report('A) Buy EVERY token at first sample (the "2-3x from $0" idea, zero filters)', rows.filter(r => r.s && r.s.length > 2).map(r => [r.s, 0]));

// B. Bot's rule: first sample inside the window
const inWin = rows.filter(r => r.s && r.s.length > 2).map(r => [r.s, r.s.findIndex(x => x[1] >= MIN && x[1] <= MAX)]).filter(x => x[1] >= 0);
report('B) Enter at first sample inside $25k-$35k', inWin);

// C. Late qualifiers we can no longer buy (age >= 5 min)
const late = rows.filter(r => r.lateWindowAgeSec != null);
console.log(`\nC) Tokens that first sat in the window only AFTER the 5-min cutoff: ${late.length}` +
  (late.length ? ` | of those, peak >= 2x window entry: ${pct(late.filter(r => r.peakMcap >= 2 * MAX).length, late.length)}` : ''));

// D. Dip re-entries
const dips = rows.filter(r => r.wasAbove);
console.log(`D) Tokens that went ABOVE $35k at some point: ${dips.length}`);
console.log('\nNOTE: sampled paths + no fees => optimistic. Treat as an upper bound, not a forecast.');
