/**
 * Storage — file-based persistence for positions, paper stats, and tracked trades.
 *
 * PITFALL FIX #2: savePaperStats() and saveTracked() were missing from the sell
 * function in the old code. Both are called explicitly from buyer.js and seller.js.
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('../../config');
const log  = require('./logger').forTag('STORAGE');

// ─── Ensure data directory exists ───────────────────────────────────────────

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Generic read/write ──────────────────────────────────────────────────────

function readJSON(filePath, defaultValue = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.error(`Failed to read ${filePath}:`, err.message);
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log.error(`Failed to write ${filePath}:`, err.message);
  }
}

// ─── Paper Stats ─────────────────────────────────────────────────────────────

/**
 * PITFALL FIX #2: This function must be called from BOTH the buy path AND the
 * sell path. The old code was only calling it in certain conditions.
 */
function savePaperStats(action, position, details = {}) {
  try {
    const stats = readJSON(cfg.paperStatsFile, {
      totalBuys: 0,
      totalSells: 0,
      totalInvested: 0,
      totalReturned: 0,
      trades: [],
    });

    const entry = {
      ts:         new Date().toISOString(),
      action,
      ticker:     position.ticker,
      mint:       position.mint,
      entryPrice: position.entryPrice,
      ...details,
    };

    if (action === 'BUY') {
      stats.totalBuys++;
      stats.totalInvested += (position.amountUSD || 0) + (details.feeUSD || 0);   // stake + buy fee
    } else if (action === 'SELL') {
      stats.totalSells++;
      stats.totalReturned += details.amountOut || 0;
    }

    stats.trades.push(entry);

    // Keep last 500 trades to avoid file bloat
    if (stats.trades.length > 500) {
      stats.trades = stats.trades.slice(-500);
    }

    stats.pnl            = stats.totalReturned - stats.totalInvested;
    stats.pnlPercent     = stats.totalInvested > 0
      ? ((stats.pnl / stats.totalInvested) * 100).toFixed(2)
      : '0.00';
    stats.lastUpdated    = new Date().toISOString();

    writeJSON(cfg.paperStatsFile, stats);
    log.debug(`Paper stats updated: ${action} ${position.ticker} pnl=${stats.pnl.toFixed(4)}`);
  } catch (err) {
    log.error('savePaperStats error:', err.message);
  }
}

// ─── Tracked Trades ──────────────────────────────────────────────────────────

/**
 * PITFALL FIX #2: saveTracked() must also be called in the sell path.
 * Used for position restoration after a crash.
 */
function saveTracked(action, position, details = {}) {
  try {
    const tracked = readJSON(cfg.trackedFile, { positions: [] });

    if (action === 'BUY') {
      // Add new position
      tracked.positions.push({
        mint:       position.mint,
        ticker:     position.ticker,
        entryPrice: position.entryPrice,
        entryMcap:  position.entryMcap,
        amountUSD:  position.amountUSD,
        entryTime:  position.entryTime,
        paperTrade: position.paperTrade,
        tier1Sold:  false,
        tier2Sold:  false,
      });
    } else if (action === 'SELL' || action === 'CLOSE') {
      // Update or remove position
      const idx = tracked.positions.findIndex(p => p.mint === position.mint);
      if (idx !== -1) {
        if (details.percentage >= 100 || details.reason === 'FULL_EXIT') {
          tracked.positions.splice(idx, 1);  // Remove closed position
        } else {
          // Partial — update flags
          if (details.reason === 'TIER1') tracked.positions[idx].tier1Sold = true;
          if (details.reason === 'TIER2') tracked.positions[idx].tier2Sold = true;
        }
      }
    }

    writeJSON(cfg.trackedFile, tracked);
  } catch (err) {
    log.error('saveTracked error:', err.message);
  }
}

// ─── Positions snapshot (for recovery after crash) ───────────────────────────

function savePositions(positionsMap) {
  try {
    const data = Object.fromEntries(positionsMap);
    writeJSON(cfg.positionsFile, { savedAt: Date.now(), positions: data });
  } catch (err) {
    log.error('savePositions error:', err.message);
  }
}

function loadPositions() {
  try {
    const data = readJSON(cfg.positionsFile, { positions: {} });
    const map  = new Map(Object.entries(data.positions || {}));
    log.info(`Loaded ${map.size} position(s) from disk`);
    return map;
  } catch (err) {
    log.error('loadPositions error:', err.message);
    return new Map();
  }
}

// ─── Paper stats summary ─────────────────────────────────────────────────────

function getPaperSummary() {
  return readJSON(cfg.paperStatsFile, {
    totalBuys: 0, totalSells: 0, totalInvested: 0, totalReturned: 0,
    pnl: 0, pnlPercent: '0.00',
  });
}

module.exports = {
  savePaperStats,
  saveTracked,
  savePositions,
  loadPositions,
  getPaperSummary,
};
