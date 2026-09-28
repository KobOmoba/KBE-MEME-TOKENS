/**
 * Scanner — Pump.fun WebSocket Token Detection
 *
 * Uses a raw WebSocket connection with the correct logsSubscribe format:
 *   { mentions: ["PUMP_FUN_PROGRAM_ID"] }
 *
 * This bypasses the @solana/web3.js onLogs serialization issue that was
 * sending the public key as a raw string instead of {"mentions": [...]}.
 *
 * Detection latency: < 1 second from token creation.
 * No Pump.fun API needed. No 530 errors.
 */

const WebSocket = require('ws');
const cfg       = require('../config');
const { extractMintFromTx } = require('./api/pumpfun');
const { evaluate }          = require('./evaluator');
const { executeBuy }        = require('./buyer');
const log                   = require('./utils/logger').forTag('SCANNER');

const PUMP_FUN_PROGRAM  = '6EF8rrectrRdC4KjqW7GqK9Wz9hEndkbskZaZKzhW9Ep';
const CREATE_LOG_FILTER = 'Instruction: Create';

// Dedup recently seen signatures
const seenSignatures = new Set();
const SEEN_MAX = 2000;

let ws           = null;
let subId        = null;
let pingInterval = null;
let reconnecting = false;

// ─── Start WebSocket scanner ──────────────────────────────────────────────────

function startScanner() {
  if (!cfg.rpcWsEndpoint) {
    throw new Error('RPC_WS_ENDPOINT not set in .env');
  }

  log.info(`Connecting to WebSocket: ${cfg.rpcWsEndpoint.slice(0, 50)}...`);

  ws = new WebSocket(cfg.rpcWsEndpoint);

  ws.on('open', () => {
    log.info('WebSocket connected — subscribing to Pump.fun logs...');

    // Send the correctly formatted logsSubscribe request
    // This is the format Helius expects: {"mentions": ["PROGRAM_ID"]}
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'logsSubscribe',
      params:  [
        { mentions: [PUMP_FUN_PROGRAM] },
        { commitment: 'confirmed' }
      ]
    }));

    // Keep-alive ping every 20 seconds
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 20000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Subscription confirmation
      if (msg.id === 1 && msg.result !== undefined) {
        subId = msg.result;
        log.info(`✅ Pump.fun WebSocket subscription active (subId: ${subId})`);
        return;
      }

      // Log notification
      if (msg.method === 'logsNotification') {
        const value = msg.params?.result?.value;
        if (!value) return;
        if (value.err !== null) return;
        if (!value.logs?.some(l => l.includes(CREATE_LOG_FILTER))) return;

        const sig = value.signature;
        if (!sig) return;

        // Dedup
        if (seenSignatures.has(sig)) return;
        seenSignatures.add(sig);
        if (seenSignatures.size > SEEN_MAX) {
          const arr = [...seenSignatures];
          arr.slice(0, 500).forEach(s => seenSignatures.delete(s));
        }

        log.debug(`New Create tx: ${sig.slice(0, 16)}...`);

        // Process async — never block the WS message handler
        processNewToken(sig).catch(err => {
          log.error(`processNewToken error [${sig.slice(0, 12)}]:`, err.message);
        });
      }
    } catch (err) {
      log.error('WebSocket message parse error:', err.message);
    }
  });

  ws.on('error', (err) => {
    log.error('WebSocket error:', err.message);
  });

  ws.on('close', (code, reason) => {
    log.warn(`WebSocket closed: code=${code} reason=${reason?.toString() || 'none'}`);
    cleanup();
  });

  ws.on('pong', () => {
    log.debug('WebSocket pong received — connection alive');
  });
}

function cleanup() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (ws) {
    try { ws.terminate(); } catch (_) {}
    ws = null;
  }
  subId = null;
}

// ─── Process new token ────────────────────────────────────────────────────────

async function processNewToken(signature) {
  const detection = await extractMintFromTx(signature);
  if (!detection || !detection.mint) {
    log.debug(`Could not extract mint from: ${signature.slice(0, 16)}...`);
    return;
  }

  const { mint, creationTime, creator } = detection;
  log.info(`New token: ${mint.slice(0, 8)}... | creator: ${creator?.slice(0, 8) || '?'}`);

  let evalResult;
  try {
    evalResult = await evaluate(detection);
  } catch (err) {
    log.error(`evaluate() error for ${mint.slice(0, 8)}:`, err.message);
    return;
  }

  if (!evalResult.pass) {
    log.debug(`[${mint.slice(0, 8)}] BLOCKED — ${evalResult.reason}`);
    return;
  }

  log.info(`✅ [${evalResult.data.ticker}] All gates passed — executing buy`);
  try {
    await executeBuy(evalResult.data);
  } catch (err) {
    log.error(`executeBuy error for ${evalResult.data.ticker}:`, err.message);
  }
}

// ─── Maintain scanner with reconnect ─────────────────────────────────────────

async function maintainScanner() {
  let failCount = 0;

  while (true) {
    try {
      cleanup();
      startScanner();
      failCount = 0;

      // Wait for WebSocket to close or error
      await new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (!ws || ws.readyState === WebSocket.CLOSED) {
            clearInterval(check);
            resolve();
          }
        }, 1000);
      });

    } catch (err) {
      failCount++;
      const delay = Math.min(5000 * failCount, 60000);
      log.error(`Scanner error (attempt ${failCount}): ${err.message} — retry in ${delay/1000}s`);
      await sleep(delay);
    }

    const delay = Math.min(3000 * (failCount + 1), 30000);
    log.warn(`Scanner disconnected — reconnecting in ${delay/1000}s...`);
    await sleep(delay);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { startScanner, maintainScanner };
