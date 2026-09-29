/**
 * Telegram Notifications — V3 §10
 * Now includes scan summary reports showing why tokens are being rejected.
 */

const cfg   = require('../config');
const log   = require('./utils/logger').forTag('TELEGRAM');

async function sendMessage(text) {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    log.warn('Telegram not configured — message suppressed');
    log.info('[TELEGRAM MOCK]\n' + text);
    return;
  }
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    cfg.telegramChatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text();
      log.warn(`Telegram HTTP ${resp.status}: ${txt.slice(0, 100)}`);
    }
  } catch (err) {
    log.warn('Telegram send error:', err.message);
  }
}

// ─── Scan Summary — why tokens are not qualifying ─────────────────────────────

async function sendScanSummary(s) {
  const mode = cfg.paperTrade ? '📄 PAPER' : '🔴 LIVE';

  const text = [
    `📊 <b>SCAN REPORT — ${mode}</b>`,
    ``,
    `⏱ Uptime: ${s.uptimeHrs}h`,
    `🔍 Tokens detected: ${s.totalDetected}`,
    `✅ Passed all gates: ${s.totalPassed}`,
    `❌ Rejected: ${s.totalRejected} (${s.passRate}% pass rate)`,
    ``,
    `<b>WHY TOKENS ARE BEING SKIPPED:</b>`,
    s.rejLines,
    ``,
    `<b>FUNNEL:</b>`,
    s.extraLines,
    ``,
    `<b>Entry rules reminder:</b>`,
    `  Age: &lt;5 min | MCap: $25k-$35k | Liq: &gt;$10k`,
    `  Score: 65/100 | Top10 wallets: &lt;30%`,
  ].join('\n');

  await sendMessage(text);
}

// ─── Buy confirmation ─────────────────────────────────────────────────────────

async function sendBuyConfirmation(pos) {
  const mode   = pos.paperTrade ? '📄 PAPER TRADE — ' : '';
  const t1stop = (pos.entryPrice * cfg.moonBagStopMultiple).toFixed(8);
  const t1     = (pos.entryPrice * cfg.tier1Multiple).toFixed(8);
  const t2     = (pos.entryPrice * cfg.tier2Multiple).toFixed(8);
  const green  = (pos.greenFlags || []).join('\n  ') || 'None listed';
  const red    = (pos.redFlags   || []).join('\n  ') || 'NONE ✅';

  const text = [
    `🟢 <b>${mode}EXECUTED — BUY CONFIRMED</b>`,
    ``,
    `Name:    <b>${pos.name} $${pos.ticker}</b>`,
    `Age:     ${pos.ageStr || '~0 min'}`,
    `MCap:    $${fmtNum(pos.entryMcap)} (window $25k–$35k)`,
    `Liq:     $${fmtNum(pos.liquidity)}`,
    `Score:   ${pos.score}/100`,
    `Dev:     ${(pos.devHoldingPct||0).toFixed(1)}% | ${pos.devTxns===0 ? 'No movement 3 min ✅' : `${pos.devTxns} txns ⚠️`}`,
    `Top 10:  ${(pos.top10Pct||0).toFixed(1)}%`,
    `B/S:     ${(pos.buySellRatio||1).toFixed(2)}`,
    `Txns:    ${pos.transactionCount || '?'}`,
    ``,
    `<b>GREEN FLAGS:</b>\n  ${green}`,
    `<b>RED FLAGS:</b>\n  ${red}`,
    ``,
    `Entry:   $${pos.entryPrice}`,
    `Position: $${(pos.amountUSD||0).toFixed(2)}`,
    `Pre-signed sells: ${pos.presignedSells ? 'READY ✅' : 'PENDING ⏳'}`,
    `Jito bundle: ${pos.presignedSells ? 'ARMED ✅' : 'PENDING ⏳'}`,
    `Priority fee (sell): 5M lamports`,
    ``,
    `<b>Exit targets:</b>`,
    `  Moon bag stop: 1.5x = $${t1stop}`,
    `  Tier 1 (50%):  2x   = $${t1}`,
    `  Tier 2 (30%):  4x   = $${t2}`,
    `  Moon bag (20%): riding`,
    ``,
    `⏱ 15-min timer: STARTED`,
  ].join('\n');

  await sendMessage(text);
}

// ─── Exit notification ────────────────────────────────────────────────────────

async function sendExitNotification(pos, reason, details = {}) {
  const mode    = pos.paperTrade ? '📄 PAPER — ' : '';
  const tierMap = {
    TIER1:      'TIER 1 (2x)',
    TIER2:      'TIER 2 (4x)',
    STOP_LOSS:  'MOON BAG STOP (1.5x)',
    TIME_EXIT:  'TIME EXIT (15 min)',
  };
  const tierLabel = tierMap[reason] || reason;
  const emoji     = reason === 'STOP_LOSS' ? '🔴' : reason === 'TIME_EXIT' ? '🟡' : '🟢';

  const text = [
    `${emoji} <b>${mode}EXIT FIRED — ${tierLabel}</b>`,
    ``,
    `Token:      <b>$${pos.ticker}</b>`,
    `Trigger:    ${tierLabel}`,
    `Sold:       ${details.percentage || '?'}% of position`,
    `Amount out: $${(details.amountOut || 0).toFixed(4)}`,
    `Execution:  ${details.method || 'Jito bundle'} — ${details.elapsed || '?'}s`,
    `Remaining:  ${details.remainingPct || 0}%`,
    ``,
    `Running total recovered: $${(pos.totalRecovered || 0).toFixed(4)}`,
  ].join('\n');

  await sendMessage(text);
}

// ─── Alert ───────────────────────────────────────────────────────────────────

async function sendAlert(title, message) {
  await sendMessage(`⚠️ <b>${title}</b>\n\n${message}`);
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function sendStartup(mode) {
  const text = [
    `🚀 <b>AariNAT Sniper V4 — STARTED</b>`,
    `Mode: ${mode}`,
    `MCap window: $25k–$35k`,
    `Score minimum: 65/100`,
    `Detection: WebSocket (Pump.fun bypassed ✅)`,
    `Loops: Scanner + Monitor + PreSign`,
    `Reports: Every 30 min — shows why tokens are being rejected`,
    ``,
    `Operator: Bayo | AariNAT Company Limited`,
  ].join('\n');
  await sendMessage(text);
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (!n && n !== 0) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return n.toFixed(0);
}

module.exports = {
  sendMessage,
  sendScanSummary,
  sendBuyConfirmation,
  sendExitNotification,
  sendAlert,
  sendStartup,
};
