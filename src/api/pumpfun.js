/**
 * Pump.fun — on-chain bonding curve data.
 *
 * This reads price and market cap DIRECTLY from the Solana blockchain,
 * bypassing the Pump.fun REST API entirely. This is how we detect new tokens
 * via WebSocket and get real-time data without API blocks.
 *
 * The bonding curve PDA: seeds = ['bonding-curve', mint]
 * Layout (after 8-byte Borsh discriminator):
 *   u64 virtualTokenReserves  — offset 8
 *   u64 virtualSolReserves    — offset 16
 *   u64 realTokenReserves     — offset 24
 *   u64 realSolReserves       — offset 32
 *   u64 tokenTotalSupply      — offset 40
 *   bool complete             — offset 48
 */

const { PublicKey } = require('@solana/web3.js');
const { getConnection, getSolPrice } = require('./rpc');
const log = require('../utils/logger').forTag('PUMPFUN');

const PUMP_FUN_PROGRAM   = new PublicKey('6EF8rrectrRdC4KjqW7GqK9Wz9hEndkbskZaZKzhW9Ep');
const LAMPORTS_PER_SOL   = 1_000_000_000n;
const TOKEN_DECIMALS     = 1_000_000n;            // 6 decimals for Pump.fun tokens
const TOTAL_SUPPLY_TOKENS = 1_000_000_000n;       // 1 billion tokens

// ─── PDA derivation ──────────────────────────────────────────────────────────

async function getBondingCurvePda(mintAddress) {
  const mint = new PublicKey(mintAddress);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBytes()],
    PUMP_FUN_PROGRAM
  );
  return pda;
}

// ─── Bonding curve state parser ───────────────────────────────────────────────

function parseBondingCurve(data) {
  if (!data || data.length < 49) {
    throw new Error(`Bonding curve data too short: ${data?.length} bytes`);
  }

  // Skip 8-byte discriminator
  const offset = 8;
  const view   = new DataView(data.buffer, data.byteOffset, data.byteLength);

  return {
    virtualTokenReserves: view.getBigUint64(offset,      true),
    virtualSolReserves:   view.getBigUint64(offset + 8,  true),
    realTokenReserves:    view.getBigUint64(offset + 16, true),
    realSolReserves:      view.getBigUint64(offset + 24, true),
    tokenTotalSupply:     view.getBigUint64(offset + 32, true),
    complete:             data[offset + 40] === 1,
  };
}

// ─── Price and market cap calculation ────────────────────────────────────────

/**
 * Turn raw bonding-curve account data into price / mcap / liquidity.
 * Returns { state: 'ok' | 'graduated', ... }.
 */
function curveFromData(data, solPrice) {
  const curve = parseBondingCurve(data);
  if (curve.complete) return { state: 'graduated' };

  // Price per token in SOL (lamports -> SOL, base units -> tokens)
  const priceSOL = (Number(curve.virtualSolReserves) / Number(LAMPORTS_PER_SOL))
                 / (Number(curve.virtualTokenReserves) / Number(TOKEN_DECIMALS));

  const marketCapSOL = priceSOL * Number(TOTAL_SUPPLY_TOKENS);
  const realSol      = Number(curve.realSolReserves) / Number(LAMPORTS_PER_SOL);

  return {
    state:        'ok',
    priceSOL,
    priceUSD:     priceSOL * solPrice,
    marketCapUSD: marketCapSOL * solPrice,
    // NOTE: the x2 is the original V4 convention (keeps the $10k liquidity gate meaningful
    // inside the $25k-$35k window). Real sellable SOL is realSolReserves.
    liquidityUSD: realSol * 2 * solPrice,
    realSol,
    realTokenReserves:    Number(curve.realTokenReserves),
    virtualTokenReserves: Number(curve.virtualTokenReserves),
    virtualSolReserves:   Number(curve.virtualSolReserves),
    complete:     false,
  };
}

/**
 * Single-token fetch (kept for compatibility). Returns null if graduated.
 */
async function getBondingCurveData(mintAddress) {
  const conn = getConnection();
  const pda  = await getBondingCurvePda(mintAddress);
  const info = await conn.getAccountInfo(pda);
  if (!info || !info.data) throw new Error(`No bonding curve account found for ${mintAddress}`);
  const c = curveFromData(info.data, await getSolPrice());
  return c.state === 'ok' ? c : null;
}

/**
 * V4.2: fetch MANY bonding curves in one RPC call (getMultipleAccounts, 100 per call).
 * This is what makes watching hundreds of new tokens cheap.
 *
 * @param {Array<{mint:string, pda:PublicKey}>} items
 * @returns {Promise<Map<string, Object>>} mint -> { state: 'ok'|'graduated'|'missing', ... }
 */
async function getBondingCurvesBatch(items) {
  const out = new Map();
  if (!items.length) return out;

  const conn     = getConnection();
  const solPrice = await getSolPrice();

  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map(x => x.pda), 'confirmed');
    chunk.forEach((item, idx) => {
      const info = infos[idx];
      if (!info || !info.data || info.data.length < 49) {
        out.set(item.mint, { state: 'missing' });
        return;
      }
      try {
        out.set(item.mint, curveFromData(info.data, solPrice));
      } catch (err) {
        out.set(item.mint, { state: 'missing', error: err.message });
      }
    });
  }
  return out;
}

// ─── Creator wallet from create transaction ───────────────────────────────────

/**
 * Extract the new mint from a Pump.fun create transaction.
 * V4.2 changes:
 *  - retries (getTransaction often returns null for the first ~1s after the log fires;
 *    the old code gave up immediately and silently lost the token)
 *  - mint must be a SIGNER (create's mint is a fresh keypair) so buy/sell txs can't be misread
 *  - creator = fee payer (works for create and create_v2; old fixed index 7 broke on v2)
 */
async function extractMintFromTx(txSignature) {
  const conn = getConnection();
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const tx = await conn.getTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.transaction) {
        await sleep(400 * attempt);
        continue;
      }

      const msg = tx.transaction.message;
      const accountKeys = (msg.staticAccountKeys || msg.accountKeys || []).map(k => k.toString());
      const instructions = msg.compiledInstructions || msg.instructions;
      if (!instructions) return null;
      const numSigners = msg.header?.numRequiredSignatures ?? 1;

      for (const ix of instructions) {
        if (accountKeys[ix.programIdIndex] !== PUMP_FUN_PROGRAM.toString()) continue;
        const mintIdx = ix.accountKeyIndexes?.[0] ?? ix.accounts?.[0];
        if (mintIdx === undefined || mintIdx >= numSigners) continue;   // not a create
        return {
          mint:         accountKeys[mintIdx],
          creationTime: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
          creator:      accountKeys[0] || null,
          signature:    txSignature,
          source:       'helius',
        };
      }
      return null;
    } catch (err) {
      if (attempt === 4) log.error(`extractMintFromTx error for ${txSignature}:`, err.message);
      else await sleep(400 * attempt);
    }
  }
  return null;
}

// ─── Holder concentration ────────────────────────────────────────────────────

const TOKEN_PROGRAM      = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM        = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function ataAddresses(owner, mint) {
  return [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map(tp =>
    PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tp.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0].toString());
}

/**
 * Top-10 holder concentration.
 *
 * V4.2 FIX: getTokenLargestAccounts ALWAYS lists the bonding curve's own token account
 * as the biggest "holder" (it holds all unsold supply). The old code counted it, so top-10
 * was 60-90% on every token, the concentration gate always failed, and the dev "override"
 * (which was fed empty data) always rescued it. Now the curve account is excluded.
 *
 * @returns {{ ok:boolean, top10Pct?, devHoldingPct?, holderCount? }}
 */
async function getTopHolderConcentration(mintAddress, creator = null) {
  try {
    const conn = getConnection();
    const mint = new PublicKey(mintAddress);
    const curvePda = await getBondingCurvePda(mintAddress);
    const skip = new Set(ataAddresses(curvePda, mint));
    const devAtas = creator ? new Set(ataAddresses(new PublicKey(creator), mint)) : new Set();

    const largest = await conn.getTokenLargestAccounts(mint);
    const rows = largest?.value || [];
    if (!rows.length) return { ok: false };

    const totalSupply = Number(TOTAL_SUPPLY_TOKENS) * Number(TOKEN_DECIMALS);
    const holders = rows.filter(r => !skip.has(r.address.toString()));

    let top10Amount = 0;
    holders.slice(0, 10).forEach(h => { top10Amount += Number(h.amount || 0); });

    let devAmount = 0;
    if (creator) {
      holders.forEach(h => { if (devAtas.has(h.address.toString())) devAmount += Number(h.amount || 0); });
    }

    return {
      ok:            true,
      top10Pct:      (top10Amount / totalSupply) * 100,
      // dev not in the top-20 list => holds less than the 20th holder => effectively small
      devHoldingPct: creator ? (devAmount / totalSupply) * 100 : null,
      holderCount:   holders.length,
    };
  } catch (err) {
    log.warn(`getTopHolderConcentration failed for ${mintAddress}: ${err.message}`);
    return { ok: false };   // caller retries next cycle — do NOT invent a number
  }
}

/** Trade count so far (signatures touching the bonding curve, max 1000). */
async function getTxnCount(pda) {
  try {
    const sigs = await getConnection().getSignaturesForAddress(pda, { limit: 1000 }, 'confirmed');
    return sigs.length;
  } catch (err) {
    log.warn(`getTxnCount failed: ${err.message}`);
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  getBondingCurveData,
  getBondingCurvesBatch,
  getBondingCurvePda,
  extractMintFromTx,
  getTopHolderConcentration,
  getTxnCount,
  PUMP_FUN_PROGRAM,
};
