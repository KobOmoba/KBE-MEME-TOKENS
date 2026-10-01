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

const BASE_URL = 'wss://pumpportal.fun/api/data';
const wsUrl = () => cfg.pumpPortalApiKey ? `${BASE_URL}?api-key=${cfg.pumpPortalApiKey}` : BASE_URL;   // never logged

let ws = null;
let connected = false;
let onCreate = () => {};
let onTrade  = () => {};
let getWatched = () => [];
let retry = 0;
let lastCreateAt = 0;
// PumpPortal's free tier only streams NEW TOKENS. Trade streams need an API key funded with >= 0.02 SOL.
// Once PumpPortal says so, we stop asking and stop pretending we have trade data.
let tradeStreamOk = true;
const diag = { createMsgs: 0, tradeMsgs: 0, notices: [], sampleTrade: null, tradeBlocked: false };
let anomalyCount = 0, noticeCount = 0, otherCount = 0, subLogCount = 0;   // diagnostics: first few unusual messages only
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
  if (mcapSol > 600) {                                   // impossible on a bonding curve (graduation ~ 400 SOL)
    if (anomalyCount++ < 3) log.warn('PP anomaly (mcapSol>600, ignored): ' + JSON.stringify(m).slice(0, 500));
    return;
  }
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
  ws = new WebSocket(wsUrl());

  ws.on('open', () => {
    connected = true; retry = 0; subscribed.clear();
    log.info('PumpPortal connected');
    send({ method: 'subscribeNewToken' });
    const mints = [...new Set([...getWatched(), ...pinned])];
    if (mints.length && tradeStreamOk) { send({ method: 'subscribeTokenTrade', keys: mints }); mints.forEach(m => subscribed.add(m)); }
  });

  ws.on('message', handleMessage);
  ws.on('error', (e) => log.warn('PumpPortal error: ' + e.message));
  ws.on('close', onClose);
}

function handleMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m) return;
    if (m.message || m.errors) {                                  // acks / errors from PumpPortal
      if (noticeCount++ < 8) log.info('PP notice: ' + JSON.stringify(m).slice(0, 300));
      if (diag.notices.length < 3) diag.notices.push(JSON.stringify(m).slice(0, 160));
      if (/funded|api key/i.test(String(m.message || ''))) {
        if (tradeStreamOk) log.warn('PumpPortal trade stream needs a funded API key — running WITHOUT trade data (prices come from the chain)');
        tradeStreamOk = false; diag.tradeBlocked = true;
      }
      return;
    }
    if (!m.mint) return;

    record(m);                                                    // keep latest price for watched mints
    if (m.txType === 'create') {
      lastCreateAt = Date.now(); diag.createMsgs++;
      if (!sampleLogged.create) { sampleLogged.create = true; log.info('PP sample create: ' + JSON.stringify(m).slice(0, 700)); }
      onCreate({
        mint: m.mint, creator: m.traderPublicKey || null, name: m.name, symbol: m.symbol,
        creationTime: Date.now(), source: 'pumpportal',
      });
    } else if (m.txType === 'buy' || m.txType === 'sell') {
      diag.tradeMsgs++; if (!diag.sampleTrade) diag.sampleTrade = JSON.stringify(m).slice(0, 260);
      if (!sampleLogged.trade) { sampleLogged.trade = true; log.info('PP sample trade: ' + JSON.stringify(m).slice(0, 700)); }
      onTrade({ mint: m.mint, trader: m.traderPublicKey, type: m.txType, sol: Number(m.solAmount) || 0 });
    } else if (otherCount++ < 5) {
      log.info('PP other message: ' + JSON.stringify(m).slice(0, 400));
    }
}

function onClose() {
    connected = false; subscribed.clear();
    latest.forEach(v => { v.stale = true; });                    // gap in the feed: prices unreliable until next event
    const delay = Math.min(3000 * ++retry, 30000);
    log.warn(`PumpPortal closed — reconnect in ${delay / 1000}s`);
    setTimeout(connect, delay);
}

/** Subscribe to trades for a mint. Returns true if the subscription was actually sent. */
function subscribe(mint) {
  if (!connected || !tradeStreamOk) return false;
  if (subscribed.has(mint)) return true;
  send({ method: 'subscribeTokenTrade', keys: [mint] });
  if (subLogCount++ < 3) log.info('PP → subscribeTokenTrade ' + mint.slice(0, 8) + '...');
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
const getDiag = () => diag;
const isTradeStreamOk = () => tradeStreamOk;
// Healthy = connected AND a create event arrived in the last 60s. If the message shape ever
// differs from what we expect, this goes false and Helius log-detection takes over again.
const isHealthy = () => connected && (Date.now() - lastCreateAt) < 60000;

module.exports = { start, subscribe, unsubscribe, pin, getLatest, getDiag, isConnected, isHealthy, isTradeStreamOk,
  _handleMessage: handleMessage, _resetTradeStream: () => { tradeStreamOk = true; diag.tradeBlocked = false; } };
