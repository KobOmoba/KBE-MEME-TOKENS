/**
 * AariNAT Meme Token Sniper — V4 Entry Point
 *
 * THREE INDEPENDENT LOOPS (spec §4 — NEVER merge these):
 *   Loop 1 — Scanner (WebSocket, event-driven)
 *   Loop 2 — Position Monitor (every 10 seconds)
 *   Loop 3 — Pre-Sign Refresh (every 45 seconds)
 *
 * PLUS: Scan summary to Telegram every 30 minutes.
 */

const cfg       = require('./config');
const tracker   = require('./src/tracker');
const buyer     = require('./src/buyer');
const { maintainScanner }        = require('./src/scanner');
const { runMonitorCycle }        = require('./src/tracker');
const { runPresignRefreshCycle } = require('./src/tracker');
const { loadPositions }          = require('./src/utils/storage');
const { checkHealth }            = require('./src/api/rpc');
const telegram                   = require('./src/telegram');
const stats                      = require('./src/utils/stats');
const log                        = require('./src/utils/logger').forTag('MAIN');

// ─── Process-level crash protection ──────────────────────────────────────────

process.on('uncaughtException', async (err) => {
  log.error('⚠️  UNCAUGHT EXCEPTION:', err.message, err.stack);
  await telegram.sendAlert('UNCAUGHT EXCEPTION', err.message).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  log.error('⚠️  UNHANDLED REJECTION:', msg);
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  log.info('═════════════════════════════════════════');
  log.info('  AariNAT Meme Token Sniper V4 — STARTING');
  log.info('═════════════════════════════════════════');

  const mode = cfg.paperTrade ? 'PAPER TRADING' : '🔴 LIVE TRADING';
  log.info(`Mode: ${mode}`);
  log.info(`MCap window: $${cfg.mcapMin.toLocaleString()} – $${cfg.mcapMax.toLocaleString()}`);
  log.info(cfg.scoreGateEnabled ? `Min score: ${cfg.minScore}/100` : 'Score gate: OFF (advisory only, recorded on every trade)');
  log.info(`Min liquidity: $${cfg.minLiquidityForBuy.toLocaleString()}`);
  log.info(`Trade size: $${cfg.tradeSize}`);
  log.info(`Exit tiers: 2x(50%) → 4x(30%) → moon bag(20%) ${cfg.moonBagStopMode === 'trail' ? `trailing ${cfg.moonBagTrailPct}% from ATH` : `stop@${cfg.moonBagStopMultiple}x`}`);
  log.info(`Time exit: ${cfg.maxHoldMinutes} min if no 2x`);

  if (!cfg.paperTrade) {
    log.warn('⚠️  LIVE TRADING ACTIVE — REAL MONEY AT RISK');
  }

  if (!cfg.rpcEndpoint) {
    log.error('FATAL: RPC_ENDPOINT not set.');
    process.exit(1);
  }

  if (!cfg.paperTrade && !cfg.privateKey) {
    log.error('FATAL: WALLET_PRIVATE_KEY not set for live trading');
    process.exit(1);
  }

  // RPC health check
  log.info('Checking RPC health...');
  const health = await checkHealth();
  if (!health.ok) {
    log.error('RPC health check FAILED:', health.error);
    if (cfg.pumpPortalEnabled) {
      // Helius is the BACKUP source. Keep running on the PumpPortal feed (watch log + paper trading).
      log.warn('⚠️  RPC DEGRADED — continuing on PumpPortal feed only. Holder/chain checks unavailable.');
      await telegram.sendAlert('RPC DEGRADED', `Helius unavailable (${String(health.error).slice(0, 80)}). Running on PumpPortal feed only.`).catch(() => {});
    } else {
      log.error('Waiting 60s before exit so PM2 does not spam a rate-limited endpoint...');
      await new Promise(r => setTimeout(r, 60000));
      process.exit(1);
    }
  } else
  log.info(`RPC OK — slot ${health.slot}, epoch ${health.epoch}`);

  // Load positions from disk (crash recovery)
  const savedPositions = loadPositions();
  const positions = savedPositions.size > 0 ? savedPositions : new Map();

  // Init shared state
  tracker.init(positions);
  buyer.init(positions);

  // Telegram startup
  await telegram.sendStartup(mode);

  // ── LOOP 2: Position Monitor (every 10s) ────────────────────────────────────
  log.info('Starting Loop 2: Position Monitor (every 10s)...');
  setInterval(async () => {
    try { await runMonitorCycle(); }
    catch (err) { log.error('Monitor loop error:', err.message); }
  }, cfg.monitorIntervalMs);

  // ── LOOP 3: Pre-Sign Refresh (every 45s) ────────────────────────────────────
  log.info('Starting Loop 3: Pre-Sign Refresh (every 45s)...');
  setInterval(async () => {
    try { await runPresignRefreshCycle(); }
    catch (err) { log.error('Pre-sign refresh loop error:', err.message); }
  }, cfg.presignRefreshMs);

  // ── SCAN SUMMARY: Every 30 minutes to Telegram ──────────────────────────────
  // Shows exactly why tokens are being rejected so Bayo can see from phone.
  log.info('Starting scan summary reports (every 30 min to Telegram)...');

  // Send first report after 10 minutes so there's some data
  setTimeout(async () => {
    const s = stats.getSummary();
    await telegram.sendScanSummary(s);
  }, 10 * 60 * 1000);

  setInterval(async () => {
    try {
      const s = stats.getSummary();
      await telegram.sendScanSummary(s);
    } catch (err) {
      log.error('Scan summary error:', err.message);
    }
  }, 30 * 60 * 1000);

  // ── LOOP 1: Scanner (WebSocket, event-driven) ────────────────────────────────
  log.info('Starting Loop 1: Scanner (WebSocket, Pump.fun bypassed)...');
  maintainScanner();

  log.info('✅ All three loops started. Bot is running.');
  log.info('   First Telegram scan report in 10 minutes.');
}

// ─── Status ping every 5 min if positions open ──────────────────────────────

setInterval(async () => {
  try {
    const { getPositions } = require('./src/tracker');
    const pos = getPositions();
    if (pos.size > 0) {
      const posLines = Array.from(pos.values()).map(p => {
        const mult = ((p.currentPrice || p.entryPrice) / p.entryPrice).toFixed(2);
        const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `  $${esc(p.ticker)}: ${mult}x | t1=${p.tier1Sold} t2=${p.tier2Sold}\n  <code>${p.mint}</code>`;
      });
      await telegram.sendMessage(`📊 <b>Positions (${pos.size} open)</b>\n${posLines.join('\n')}`);
    }
  } catch (_) {}
}, 5 * 60 * 1000);

main().catch(async (err) => {
  log.error('FATAL startup error:', err.message, err.stack);
  await telegram.sendAlert('STARTUP FAILURE', err.message).catch(() => {});
  process.exit(1);
});
