/**
 * RPC — Solana connection with automatic reconnection.
 *
 * CRASH FIX (Task 2): WebSocket drops were causing uncaught errors.
 * This module wraps the connection and re-establishes it automatically.
 * Chain reads: free public node first in PAPER mode, Helius last; LIVE mode keeps the private-first rule.
 */

const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const cfg  = require('../../config');
const log  = require('../utils/logger').forTag('RPC');

let _connection = null;
let _wallet     = null;

// ─── Connection ──────────────────────────────────────────────────────────────

function getConnection() {
  if (!cfg.rpcEndpoint) {
    throw new Error('RPC_ENDPOINT not set in .env — cannot connect. Set a private Helius or Triton endpoint.');
  }
  if (!_connection) {
    _connection = new Connection(cfg.rpcEndpoint, {
      commitment:         'confirmed',
      wsEndpoint:         cfg.rpcWsEndpoint || undefined,
      disableRetryOnRateLimit: true,     // V4.2: no 4x retry storm on 429 — the cooldown below handles it
      confirmTransactionInitialTimeout: 30000,
    });
    let host = 'rpc'; try { host = new URL(cfg.rpcEndpoint).host; } catch (_) {}
    log.info(`Connected to RPC: ${host}`);
  }
  return _connection;
}

// Call this if the connection is detected as stale / dropped
function resetConnection() {
  log.warn('Resetting RPC connection...');
  _connection = null;
  return getConnection();
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

function getWallet() {
  if (_wallet) return _wallet;
  if (!cfg.privateKey) {
    if (cfg.paperTrade) {
      // Paper trading doesn't need a real wallet — use a dummy
      log.warn('No WALLET_PRIVATE_KEY set — using dummy wallet for paper trading only.');
      _wallet = Keypair.generate();
      return _wallet;
    }
    throw new Error('WALLET_PRIVATE_KEY not set in .env');
  }
  try {
    const decoded = bs58.decode(cfg.privateKey);
    _wallet = Keypair.fromSecretKey(decoded);
    log.info(`Wallet loaded: ${_wallet.publicKey.toString().slice(0, 8)}...`);
  } catch (err) {
    throw new Error(`Invalid WALLET_PRIVATE_KEY: ${err.message}`);
  }
  return _wallet;
}

// ─── Multi-endpoint chain reads with per-endpoint cooldown ────────────────────
// Order: paper => [public node, Helius]   live => [Helius, public node]
// An endpoint that rate-limits (429/403/timeout) is skipped for 60s (15s for other transport errors),
// so we never hammer a blocked provider. Semantic errors (e.g. "not a token mint") do NOT trip it.
const READ_ERR = /429|403|too many|max usage|forbidden|rate limit|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|50[234]/i;
const RATE_ERR = /429|too many|max usage|rate limit/i;
const _conns = new Map();
const _downUntil = new Map();

function readEndpoints() {
  const pub  = cfg.readRpcEndpoint ? [{ name: 'public', url: cfg.readRpcEndpoint }] : [];
  const priv = cfg.rpcEndpoint     ? [{ name: 'helius', url: cfg.rpcEndpoint }]     : [];
  return cfg.paperTrade ? [...pub, ...priv] : [...priv, ...pub];
}
function connFor(ep) {
  if (!_conns.has(ep.name)) {
    _conns.set(ep.name, new Connection(ep.url, { commitment: 'confirmed', disableRetryOnRateLimit: true }));
    let host = 'rpc'; try { host = new URL(ep.url).host; } catch (_) {}
    log.info(`Chain-read endpoint ready: ${ep.name} (${host})`);
  }
  return _conns.get(ep.name);
}

async function withRpc(fn) {
  let lastErr = null;
  for (const ep of readEndpoints()) {
    if (Date.now() < (_downUntil.get(ep.name) || 0)) continue;
    try { return await fn(connFor(ep), ep.name); }
    catch (err) {
      const msg = String((err && err.message) || err);
      if (!READ_ERR.test(msg)) throw err;                                     // not the endpoint's fault
      lastErr = err;
      _downUntil.set(ep.name, Date.now() + (RATE_ERR.test(msg) ? 60000 : 15000));
      log.warn(`RPC ${ep.name} failed (${msg.slice(0, 70)}) — pausing it, trying next`);
    }
  }
  throw lastErr || new Error('RPC cooldown: all endpoints are cooling down');
}

// Compatibility helpers (older call sites)
function markRpcDown(err) {
  if (RATE_ERR.test(String((err && err.message) || err))) readEndpoints().forEach(ep => _downUntil.set(ep.name, Date.now() + 60000));
}
const isRpcDown = () => readEndpoints().every(ep => Date.now() < (_downUntil.get(ep.name) || 0));

// ─── SOL price ───────────────────────────────────────────────────────────────
// V4.2: price.jup.ag/v6 is retired. The old code retried a dead endpoint (5s timeout)
// on EVERY call, stalling every evaluation and pricing mcap off a stale $150.
// Now: try several free sources, cache 60s, back off 15s on total failure, share one
// in-flight request between callers.

let _solPrice     = 150;
let _solPriceAt   = 0;
let _solInflight  = null;
const SOL_PRICE_TTL  = 60000;
const SOL_FAIL_RETRY = 15000;

const SOL_SOURCES = [
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    pick: d => parseFloat(d?.data?.amount) },
  { name: 'jupiter',  url: `https://lite-api.jup.ag/price/v3?ids=${cfg.solMint}`,
    pick: d => d?.[cfg.solMint]?.usdPrice },
];

async function fetchSolPrice() {
  for (const src of SOL_SOURCES) {
    try {
      const resp = await fetch(src.url, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) continue;
      const price = Number(src.pick(await resp.json()));
      if (price > 5 && price < 2000) {
        log.debug(`SOL price ${price} via ${src.name}`);
        return price;
      }
    } catch (_) { /* try next source */ }
  }
  return null;
}

async function getSolPrice() {
  const now = Date.now();
  if (now - _solPriceAt < SOL_PRICE_TTL) return _solPrice;
  if (_solInflight) return _solInflight;

  _solInflight = (async () => {
    const price = await fetchSolPrice();
    if (price) {
      _solPrice   = price;
      _solPriceAt = Date.now();
    } else {
      // Back off so we do not hammer dead endpoints on every evaluation
      _solPriceAt = Date.now() - SOL_PRICE_TTL + SOL_FAIL_RETRY;
      log.warn(`Could not refresh SOL price from any source, using last known: $${_solPrice}`);
    }
    _solInflight = null;
    return _solPrice;
  })();
  return _solInflight;
}

// ─── Health check ────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const slot  = await withRpc(c => c.getSlot());
    const epoch = await withRpc(c => c.getEpochInfo());
    return { ok: true, slot, epoch: epoch.epoch };
  } catch (err) {
    log.error('RPC health check failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getConnection, resetConnection, getWallet, getSolPrice, checkHealth, withRpc, markRpcDown, isRpcDown, _resetRpcState: () => _downUntil.clear(), PublicKey };
