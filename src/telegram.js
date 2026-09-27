/**
 * Telegram Notifications — V3 §10
 *
 * ALL notifications go to operator AFTER execution, not before.
 * No confirmation gates exist in this bot. Bayo sees what happened, not a question.
 */

const cfg = require('../config');
const log = require('./utils/logger').forTag('TELEGRAM');

// ─── HTTP send (no Telegraf dependency needed for fire-and-forget) ────────────

async function sendMessage(text) {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    log.warn('Telegram not configured — message suppressed');
    log.info('[TELEGRAM MOCK]', text);
    return;
  }

  try {
    const url  = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
    const body = {
      chat_id:    cfg.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      log.warn(`Telegram send failed: HTTP ${resp.status} — ${txt.slice(0, 100)}`);
    }
  } catch (err) {
    log.warn('Telegram send error:', err.message);
    // Never throw — notification failure must never crash the bot
  }
}

// ─── Buy confirmation — §10.1 ─────────────────────────────────────────────────

async function sendBuyConfirmation(pos) {
  const mode   = pos.paperTrade ? '📄 PAPER TRADE — ' : '';
  const t1stop = (pos.entryPrice * cfg.moonBagStopMultiple).toFixed(8);
  const t1     = (pos.entryPrice * cfg.tier1Multiple).toFixed(8);
  const t2     = (pos.entryPrice * cfg.tier2Multiple).toFixed(8);

  const greenFlags = (pos.greenFlags || []).join('\n  ') || 'None listed';
  const redFlags   = (pos.redFlags   || []).join('\n  ') || 'NONE ✅';

  const text = [
    `🟢 <b>${mode}EXECUTED — BUY CONFIRMED</b>`,
    ``,
    `Name:    <b>${pos.name} $${pos.ticker}</b>`,
    `Age:     ${pos.ageStr || '~0 min'}`,
    `MCap:    $${fmtNum(pos.entryMcap)} (window $25k–$35k)`,
    `Liq:     $${fmtNum(pos.liquidity)}`,
    `Score:   ${pos.score}/100`,
    `Dev:     ${pos.devHoldingPct?.toFixed(1) || '?'}% | ${pos.devTxns === 0 ? 'No movement 3 min ✅' : `${pos.devTxns} txns ⚠️`}`,
    `Top 10:  ${pos.top10Pct?.toFixed(1) || '?'}%`,
    `B/S:     ${pos.buySellRatio?.toFixed(2) || '?'}`,
    `Txns:    ${pos.transactionCount || '?'}`,
    ``,
    `<b>GREEN FLAGS:</b>`,
    `  ${greenFlags}`,
    `<b>RED FLAGS:</b>`,
    `  ${redFlags}`,
    ``,
    `Entry:   $${pos.entryPrice}`,
    `Position: $${pos.amountUSD?.toFixed(2)}`,
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

// ─── Exit notification — §10.2 ────────────────────────────────────────────────

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
    `Token:     <b>$${pos.ticker}</b>`,
    `Trigger:   ${tierLabel}`,
    `Sold:      ${details.percentage || '?'}% of position`,
    `Amount out: $${(details.amountOut || 0).toFixed(4)}`,
    `Execution: ${details.method || 'Jito bundle'} — ${details.elapsed || '?'}s`,
    `Remaining: ${details.remainingPct || 0}%`,
    ``,
    `Running total recovered: $${(pos.totalRecovered || 0).toFixed(4)}`,
  ].join('\n');

  await sendMessage(text);
}

// ─── Crash / warning ─────────────────────────────────────────────────────────

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

module.exports = { sendMessage, sendBuyConfirmation, sendExitNotification, sendAlert, sendStartup };
