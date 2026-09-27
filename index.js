/**
 * AariNAT Meme Token Sniper — V4 Entry Point
 * ──────────────────────────────────────────────────────────────────────────────
 * Operator: Bayo | AariNAT Company Limited (RC-1732521)
 *
 * THREE INDEPENDENT LOOPS (spec §4 — NEVER merge these):
 *
 *   Loop 1 — Scanner (WebSocket, event-driven)
 *     Detects new Pump.fun token launches via Solana onLogs.
 *     Bypasses Pump.fun API entirely — no 530/403 errors.
 *     Runs gate sequence → executes buy → sends Telegram notification.
 *
 *   Loop 2 — Position Monitor (every 10 seconds)
 *     Watches all open positions for exit triggers:
 *     1.5x stop loss | 2x Tier1 | 4x Tier2 | 15-min time exit
 *
 *   Loop 3 — Pre-Sign Refresh (every 45 seconds)
 *     Rebuilds pre-signed exit transactions before they expire (~60s).
 *
 * CRASH FIX (Task 2):
 *   - process.on('uncaughtException') prevents crashes from unhandled throws
 *   - process.on('unhandledRejection') prevents crashes from async errors
 *   - Each loop is wrapped in try-catch and never blocks the others
 *   - Scanner has its own reconnect loop with exponential backoff
 */

const cfg       = require('./config');
const tracker   = require('./src/tracker');
const buyer     = require('./src/buyer');
const { maintainScanner }  = require('./src/scanner');
const { runMonitorCycle }  = require('./src/tracker');
const { runPresignRefreshCycle } = require('./src/tracker');
const { loadPositions }    = require('./src/utils/storage');
const { checkHealth }      = require('./src/api/rpc');
const telegram             = require('./src/telegram');
const log                  = require('./src/utils/logger').forTag('MAIN');

// ─── Process-level crash protection ──────────────────────────────────────────
// CRASH FIX (Task 2): These handlers stop Node.js from exiting on unhandled errors.
// PM2 will restart after crashes, but we want to PREVENT the crash in the first place.
// With these handlers, errors are logged but the process continues running.

process.on('uncaughtException', async (err) => {
  log.error('⚠️  UNCAUGHT EXCEPTION:', err.message, err.stack);
  await telegram.sendAlert('UNCAUGHT EXCEPTION', err.message).catch(() => {});
  // Do NOT call process.exit() — let the loops continue
});

process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason?.message || String(reason);
  log.error('⚠️  UNHANDLED REJECTION:', msg);
  // Do not crash — log and continue
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  log.info('═════════════════════════════════════════');
  log.info('  AariNAT Meme Token Sniper V4 — STARTING');
  log.info('═════════════════════════════════════════');

  const mode = cfg.paperTrade ? 'PAPER TRADING' : '🔴 LIVE TRADING';
  log.info(`Mode: ${mode}`);
  log.info(`MCap window:  $${cfg.mcapMin.toLocaleString()} – $${cfg.mcapMax.toLocaleString()}`);
  log.info(`Min score:    ${cfg.minScore}/100`);
  log.info(`Min liquidity: $${cfg.minLiquidityForBuy.toLocaleString()}`);
  log.info(`Trade size:   $${cfg.tradeSize}`);
  log.info(`Exit tiers:   2x(50%) → 4x(30%) → moon bag(20%) stop@1.5x`);
  log.info(`Time exit:    ${cfg.maxHoldMinutes} min if no 2x`);

  if (!cfg.paperTrade) {
    log.warn('⚠️  LIVE TRADING ACTIVE — REAL MONEY AT RISK');
    log.warn('   Ensure paper trading showed consistent profit first');
  }

  // ─── Config validation ───────────────────────────────────────────────────
  if (!cfg.rpcEndpoint) {
    log.error('FATAL: RPC_ENDPOINT not set. Cannot start without a private RPC.');
    log.error('Get a Helius or Triton endpoint and add to .env');
    process.exit(1);
  }

  if (!cfg.paperTrade && !cfg.privateKey) {
    log.error('FATAL: WALLET_PRIVATE_KEY not set for live trading');
    process.exit(1);
  }

  if (!cfg.paperTrade && !cfg.telegramBotToken) {
    log.warn('WARNING: TELEGRAM_BOT_TOKEN not set — no trade notifications');
  }

  // ─── RPC health check ────────────────────────────────────────────────────
  log.info('Checking RPC health...');
  const health = await checkHealth();
  if (!health.ok) {
    log.error('RPC health check FAILED:', health.error);
    log.error('Cannot start — fix RPC endpoint first');
    process.exit(1);
  }
  log.info(`RPC OK — slot ${health.slot}, epoch ${health.epoch}`);

  // ─── Load positions from disk (crash recovery) ───────────────────────────
  const savedPositions = loadPositions();
  const positions = savedPositions.size > 0 ? savedPositions : new Map();

  // ─── Init shared state ───────────────────────────────────────────────────
  tracker.init(positions);
  buyer.init(positions);

  // ─── Telegram startup notification ───────────────────────────────────────
  await telegram.sendStartup(mode);

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 2: Position Monitor — every 10 seconds
  // Checks all open positions for exit triggers.
  // NEVER merged with the scanner — runs independently on its own interval.
  // ─────────────────────────────────────────────────────────────────────────
  log.info('Starting Loop 2: Position Monitor (every 10s)...');
  setInterval(async () => {
    try {
      await runMonitorCycle();
    } catch (err) {
      log.error('Monitor loop error (non-fatal):', err.message);
    }
  }, cfg.monitorIntervalMs);

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 3: Pre-Sign Refresh — every 45 seconds
  // Rebuilds expiring presigned transactions.
  // NEVER merged with the scanner — runs independently on its own interval.
  // ─────────────────────────────────────────────────────────────────────────
  log.info('Starting Loop 3: Pre-Sign Refresh (every 45s)...');
  setInterval(async () => {
    try {
      await runPresignRefreshCycle();
    } catch (err) {
      log.error('Pre-sign refresh loop error (non-fatal):', err.message);
    }
  }, cfg.presignRefreshMs);

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 1: Scanner — WebSocket, event-driven, self-reconnecting
  // Detects new Pump.fun tokens directly from the Solana blockchain.
  // Bypasses Pump.fun API — no 530/403 blocks.
  // NEVER merged with the monitor — runs independently as a WebSocket subscription.
  // ─────────────────────────────────────────────────────────────────────────
  log.info('Starting Loop 1: Scanner (WebSocket, Pump.fun bypassed)...');
  maintainScanner(); // Does not return — runs forever with reconnect

  log.info('✅ All three loops started. Bot is running.');
  log.info('   (Ctrl+C to stop, or use PM2 for production)');
}

// ─── Status reporter (every 5 minutes to Telegram) ───────────────────────────

setInterval(async () => {
  try {
    const { getPositions } = require('./src/tracker');
    const pos = getPositions();
    if (pos.size > 0) {
      const posLines = Array.from(pos.values()).map(p => {
        const mult = ((p.currentPrice || p.entryPrice) / p.entryPrice).toFixed(2);
        return `  $${p.ticker}: ${mult}x | t1=${p.tier1Sold} t2=${p.tier2Sold}`;
      });
      await telegram.sendMessage(`📊 <b>Status</b> (${pos.size} open)\n${posLines.join('\n')}`);
    }
  } catch (_) {}
}, 5 * 60 * 1000);

main().catch(async (err) => {
  log.error('FATAL startup error:', err.message, err.stack);
  await telegram.sendAlert('STARTUP FAILURE', err.message).catch(() => {});
  process.exit(1);
});
