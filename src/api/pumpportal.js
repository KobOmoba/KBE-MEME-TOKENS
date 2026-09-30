/**
 * PumpPortal feed — ONE websocket, used for two things:
 *   1. subscribeNewToken  -> backup token detection (deduped against the Helius feed)
 *   2. subscribeTokenTrade -> live buy/sell events for tokens on the watchlist
 *      (gives buy/sell ratio, trade count, and dev-wallet activity with ZERO RPC calls)
 *
 * PumpPortal asks for a single connection per user — do not open more.
 * It is a free third-party service: the bot MUST keep working if this feed is down
 * (scores are then computed from the components we can still measure).
 *
 * NOTE: message field names below are from memory of the PumpPortal docs. On first run
 * check the logs for "PP sample" lines and confirm the fields before trusting the data.
 */

const WebSocket = require('ws');
const cfg = require('../../config');
const log = require('../utils/logger').forTag('PUMPPORTAL');

const URL = 'wss://pumpportal.fun/api/data';

let ws = null;
let connected = false;
let onCreate = () => {};
let onTrade  = () => {};
let getWatched = () => [];
let retry = 0;
let lastCreateAt = 0;
let sampleLogged = { create: false, trade: false };
const subscribed = new Set();
const pinned = new Set();            // open positions: never unsubscribed
const latest = new Map();            // mint -> { mcapSol, vSol, ts, stale }  (free price source)

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Latest bonding-curve state per mint straight from trade events (no RPC needed).
// Field names (marketCapSol, vSolInBondingCurve) are from memory of the PumpPortal docs: the
// watchlist cross-checks near-window tokens against on-chain data and warns on mismatch.
function record(m) {
  const mcapSol = Number(m.marketCapSol), vSol = Number(m.vSolInBondingCurve);
  if (!(mcapSol > 0) || !isFinite(mcapSol)) return;
  latest.set(m.mint, { mcapSol, vSol: isFinite(vSol) && vSol > 0 ? vSol : null, ts: Date.now(), stale: false });
}

function start(handlers) {
  if (!cfg.pumpPortalEnabled) { log.info('PumpPortal disabled (PUMPPORTAL=off)'); return; }
  onCreate   = handlers.onCreate   || onCreate;
  onTrade    = handlers.onTrade    || onTrade;
  getWatched = handlers.getWatched || getWatched;
  connect();
}

function connect() {
  ws = new WebSocket(URL);

  ws.on('open', () => {
    connected = true; retry = 0; subscribed.clear();
    log.info('PumpPortal connected');
    send({ method: 'subscribeNewToken' });
    const mints = [...new Set([...getWatched(), ...pinned])];
    if (mints.length) { send({ method: 'subscribeTokenTrade', keys: mints }); mints.forEach(m => subscribed.add(m)); }
  });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || m.message || m.errors || !m.mint) return;          // acks / errors

    record(m);                                                    // keep latest price for watched mints
    if (m.txType === 'create') {
      lastCreateAt = Date.now();
      if (!sampleLogged.create) { sampleLogged.create = true; log.info('PP sample create: ' + JSON.stringify(m).slice(0, 300)); }
      onCreate({
        mint: m.mint, creator: m.traderPublicKey || null, name: m.name, symbol: m.symbol,
        creationTime: Date.now(), source: 'pumpportal',
      });
    } else if (m.txType === 'buy' || m.txType === 'sell') {
      if (!sampleLogged.trade) { sampleLogged.trade = true; log.info('PP sample trade: ' + JSON.stringify(m).slice(0, 300)); }
      onTrade({ mint: m.mint, trader: m.traderPublicKey, type: m.txType, sol: Number(m.solAmount) || 0 });
    }
  });

  ws.on('error', (e) => log.warn('PumpPortal error: ' + e.message));
  ws.on('close', () => {
    connected = false; subscribed.clear();
    latest.forEach(v => { v.stale = true; });                    // gap in the feed: prices unreliable until next event
    const delay = Math.min(3000 * ++retry, 30000);
    log.warn(`PumpPortal closed — reconnect in ${delay / 1000}s`);
    setTimeout(connect, delay);
  });
}

/** Subscribe to trades for a mint. Returns true if the subscription was actually sent. */
function subscribe(mint) {
  if (!connected) return false;
  if (subscribed.has(mint)) return true;
  send({ method: 'subscribeTokenTrade', keys: [mint] });
  subscribed.add(mint);
  return true;
}
function unsubscribe(mint) {
  if (pinned.has(mint)) return;
  latest.delete(mint);
  if (!connected || !subscribed.has(mint)) return;
  send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  subscribed.delete(mint);
}
/** Keep a mint subscribed forever (open position) and re-subscribe after every reconnect. */
function pin(mint) { pinned.add(mint); subscribe(mint); }
const getLatest = (mint) => latest.get(mint) || null;
const isConnected = () => connected;
// Healthy = connected AND a create event arrived in the last 60s. If the message shape ever
// differs from what we expect, this goes false and Helius log-detection takes over again.
const isHealthy = () => connected && (Date.now() - lastCreateAt) < 60000;

module.exports = { start, subscribe, unsubscribe, pin, getLatest, isConnected, isHealthy };
