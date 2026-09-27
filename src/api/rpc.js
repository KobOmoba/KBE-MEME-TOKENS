/**
 * RPC — Solana connection with automatic reconnection.
 *
 * CRASH FIX (Task 2): WebSocket drops were causing uncaught errors.
 * This module wraps the connection and re-establishes it automatically.
 * Never uses public RPC — private Helius or Triton endpoint required.
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
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 30000,
    });
    log.info(`Connected to RPC: ${cfg.rpcEndpoint.slice(0, 40)}...`);
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

// ─── SOL price (from Jupiter) ────────────────────────────────────────────────

let _solPrice     = 150;
let _solPriceAt   = 0;
const SOL_PRICE_TTL = 60000; // Refresh every 60 seconds

async function getSolPrice() {
  const now = Date.now();
  if (now - _solPriceAt < SOL_PRICE_TTL) return _solPrice;

  try {
    const url = `${cfg.jupiterPriceUrl}?ids=${cfg.solMint}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const price = data?.data?.[cfg.solMint]?.price;
    if (price && price > 0) {
      _solPrice   = price;
      _solPriceAt = now;
      log.debug(`SOL price updated: $${price}`);
    }
  } catch (err) {
    log.warn('Could not refresh SOL price, using last known:', _solPrice);
  }
  return _solPrice;
}

// ─── Health check ────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const conn  = getConnection();
    const slot  = await conn.getSlot();
    const epoch = await conn.getEpochInfo();
    return { ok: true, slot, epoch: epoch.epoch };
  } catch (err) {
    log.error('RPC health check failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getConnection, resetConnection, getWallet, getSolPrice, checkHealth, PublicKey };
