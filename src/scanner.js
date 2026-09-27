/**
 * Scanner — Pump.fun WebSocket Token Detection
 *
 * This is the fix for the 530/403 Pump.fun API block.
 * Instead of polling Pump.fun's REST API, we subscribe directly to the
 * Solana blockchain via connection.onLogs(PUMP_FUN_PROGRAM_ID).
 *
 * Pump.fun is a Solana program. Every new token launch is an on-chain 'Create'
 * instruction. We detect it in the mempool before most API scrapers see it.
 *
 * Detection latency: typically < 1 second from token creation.
 * No Pump.fun API needed. No proxies. No 530 errors.
 *
 * Loop 1 of the three-loop architecture (spec §4).
 * This loop is event-driven, not interval-based.
 */

const { getConnection, resetConnection }  = require('./api/rpc');
const { extractMintFromTx }               = require('./api/pumpfun');
const { evaluate }                        = require('./evaluator');
const { executeBuy }                      = require('./buyer');
const log                                 = require('./utils/logger').forTag('SCANNER');

const PUMP_FUN_PROGRAM    = '6EF8rrectrRdC4KjqW7GqK9Wz9hEndkbskZaZKzhW9Ep';
const CREATE_LOG_FILTER   = 'Instruction: Create';

// Dedup: track recently seen tx signatures to avoid processing duplicates
const seenSignatures = new Set();
const SEEN_MAX = 2000;
let subId = null;

// ─── Start scanner ────────────────────────────────────────────────────────────

async function startScanner() {
  const conn = getConnection();
  log.info(`Subscribing to Pump.fun program logs (${PUMP_FUN_PROGRAM.slice(0, 8)}...)...`);

  // Unsubscribe any existing subscription
  if (subId !== null) {
    try { await conn.removeOnLogsListener(subId); } catch (_) {}
    subId = null;
  }

  subId = conn.onLogs(
    PUMP_FUN_PROGRAM,
    async (logs, _ctx) => {
      // Ignore failed transactions
      if (logs.err !== null) return;

      // Only process 'Create' instructions — new token launches
      if (!logs.logs.some(l => l.includes(CREATE_LOG_FILTER))) return;

      const sig = logs.signature;

      // Dedup guard
      if (seenSignatures.has(sig)) return;
      seenSignatures.add(sig);
      if (seenSignatures.size > SEEN_MAX) {
        // Prune oldest entries
        const arr = [...seenSignatures];
        arr.slice(0, 500).forEach(s => seenSignatures.delete(s));
      }

      log.debug(`New Create tx detected: ${sig.slice(0, 16)}...`);

      // Process asynchronously — never await inside onLogs to avoid blocking
      processNewToken(sig).catch(err => {
        log.error(`processNewToken error [${sig.slice(0, 12)}]:`, err.message);
      });
    },
    'confirmed'
  );

  log.info(`✅ Scanner WebSocket subscription active (subId: ${subId})`);
  return subId;
}

// ─── Process a newly detected token ──────────────────────────────────────────

async function processNewToken(signature) {
  // Step 1: Get mint address from the create transaction
  const detection = await extractMintFromTx(signature);
  if (!detection || !detection.mint) {
    log.debug(`Could not extract mint from tx: ${signature.slice(0, 16)}...`);
    return;
  }

  const { mint, creationTime, creator } = detection;
  log.info(`New token: ${mint.slice(0, 8)}... | creator: ${creator?.slice(0, 8) || '?'}`);

  // NOTE: The age gate is the FIRST check inside evaluate() — before any API calls.
  // If we somehow see a token that's already too old (e.g., from a delayed WebSocket
  // event), evaluate() will reject it at Gate 1 immediately.

  // Step 2: Run full gate sequence
  let evalResult;
  try {
    evalResult = await evaluate(detection);
  } catch (err) {
    log.error(`evaluate() error for ${mint.slice(0, 8)}:`, err.message);
    return;
  }

  if (!evalResult.pass) {
    log.debug(`[${mint.slice(0, 8)}] BLOCKED — ${evalResult.reason}: ${JSON.stringify(evalResult.detail || '')}`);
    return;
  }

  // Step 3: All gates passed — execute buy immediately
  // Spec §5: No operator confirmation step. Bot detects → gates pass → buy fires.
  log.info(`✅ [${evalResult.data.ticker}] All gates passed — executing buy`);
  try {
    await executeBuy(evalResult.data);
  } catch (err) {
    log.error(`executeBuy error for ${evalResult.data.ticker}:`, err.message);
  }
}

// ─── Reconnect loop ───────────────────────────────────────────────────────────
// CRASH FIX (Task 2): WebSocket drops caused uncaught errors and crashes.
// This loop maintains the subscription and reconnects automatically.

async function maintainScanner() {
  let failCount = 0;

  while (true) {
    try {
      const id = await startScanner();
      failCount = 0;
      log.info(`Scanner active on subscription ${id}`);

      // Keep alive — check every 30s that the connection is still healthy
      while (true) {
        await sleep(30000);
        try {
          const conn = getConnection();
          await conn.getSlot(); // Lightweight health check
          log.debug('Scanner connection: healthy');
        } catch (err) {
          log.warn('Scanner connection health check failed — reconnecting:', err.message);
          break;
        }
      }

    } catch (err) {
      failCount++;
      const delay = Math.min(5000 * failCount, 60000); // Max 60s backoff
      log.error(`Scanner error (attempt ${failCount}):`, err.message, `— retrying in ${delay/1000}s`);

      // If repeated failures, reset the connection object entirely
      if (failCount >= 3) {
        log.warn('Resetting RPC connection due to repeated failures...');
        resetConnection();
      }

      await sleep(delay);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { startScanner, maintainScanner };
