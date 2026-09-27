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
 * Get real-time price and market cap from the bonding curve on-chain.
 *
 * price in SOL = virtualSolReserves / virtualTokenReserves
 *             (adjusted for decimals: lamports → SOL, base units → tokens)
 *
 * marketCapSOL = price * totalSupply (1B tokens)
 */
async function getBondingCurveData(mintAddress) {
  const conn = getConnection();

  const pda = await getBondingCurvePda(mintAddress);
  const accountInfo = await conn.getAccountInfo(pda);

  if (!accountInfo || !accountInfo.data) {
    throw new Error(`No bonding curve account found for ${mintAddress}`);
  }

  const curve = parseBondingCurve(accountInfo.data);

  if (curve.complete) {
    // Token has graduated to Raydium — no longer on bonding curve
    return null;
  }

  const solPrice = await getSolPrice();

  // Price per token in SOL
  // virtualSolReserves in lamports, virtualTokenReserves in base units (1e6 per token)
  const priceSOL = (Number(curve.virtualSolReserves) / Number(LAMPORTS_PER_SOL))
                 / (Number(curve.virtualTokenReserves) / Number(TOKEN_DECIMALS));

  const priceUSD       = priceSOL * solPrice;
  const marketCapSOL   = priceSOL * Number(TOTAL_SUPPLY_TOKENS);
  const marketCapUSD   = marketCapSOL * solPrice;
  const liquiditySOL   = Number(curve.realSolReserves) / Number(LAMPORTS_PER_SOL) * 2; // 2x (AMM both sides)
  const liquidityUSD   = liquiditySOL * solPrice;

  return {
    priceSOL,
    priceUSD,
    marketCapUSD,
    liquidityUSD,
    virtualTokenReserves: Number(curve.virtualTokenReserves),
    virtualSolReserves:   Number(curve.virtualSolReserves),
    realSolReserves:      Number(curve.realSolReserves),
    complete:             curve.complete,
  };
}

// ─── Creator wallet from create transaction ───────────────────────────────────

/**
 * Extract mint address from a Pump.fun create transaction.
 * In the Pump.fun IDL, the create instruction's first account is the mint.
 */
async function extractMintFromTx(txSignature) {
  const conn = getConnection();
  try {
    const tx = await conn.getTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx || !tx.transaction) return null;

    const msg = tx.transaction.message;

    // Handle both legacy and versioned (v0) transactions
    const accountKeys = msg.staticAccountKeys
      ? msg.staticAccountKeys.map(k => k.toString())
      : msg.accountKeys?.map(k => k.toString()) || [];

    const instructions = msg.compiledInstructions || msg.instructions;
    if (!instructions) return null;

    for (const ix of instructions) {
      const programIdx = ix.programIdIndex;
      if (accountKeys[programIdx] === PUMP_FUN_PROGRAM.toString()) {
        // Pump.fun create instruction: accounts[0] = mint
        const mintIdx = ix.accountKeyIndexes?.[0] ?? ix.accounts?.[0];
        if (mintIdx !== undefined) {
          const creationTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
          const creator      = accountKeys[ix.accountKeyIndexes?.[7] ?? 7] || null;
          return {
            mint:         accountKeys[mintIdx],
            creationTime,
            creator,
            signature:    txSignature,
          };
        }
      }
    }
    return null;
  } catch (err) {
    log.error(`extractMintFromTx error for ${txSignature}:`, err.message);
    return null;
  }
}

// ─── Top token holders ────────────────────────────────────────────────────────

async function getTopHolderConcentration(mintAddress) {
  try {
    const conn    = getConnection();
    const mint    = new PublicKey(mintAddress);
    const largest = await conn.getTokenLargestAccounts(mint);

    if (!largest?.value?.length) return { top10Pct: 0, holderCount: 0 };

    // Sum the top 10
    const totalSupply = Number(TOTAL_SUPPLY_TOKENS) * Number(TOKEN_DECIMALS);
    let top10Amount   = 0;
    const holders     = largest.value.slice(0, 10);

    for (const h of holders) {
      top10Amount += Number(h.amount || 0);
    }

    const top10Pct = (top10Amount / totalSupply) * 100;

    return { top10Pct, holderCount: largest.value.length };
  } catch (err) {
    log.warn(`getTopHolderConcentration failed for ${mintAddress}:`, err.message);
    return { top10Pct: 100, holderCount: 0 }; // Fail safe: assume worst case
  }
}

module.exports = {
  getBondingCurveData,
  extractMintFromTx,
  getTopHolderConcentration,
  PUMP_FUN_PROGRAM,
};
