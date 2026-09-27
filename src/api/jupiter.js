/**
 * Jupiter — price data and swap execution.
 *
 * Buys are executed via Jupiter. Sells are via Jito bundles (pre-signed).
 * Jupiter price API is free. Jupiter swap API requires RPC.
 */

const { getConnection, getWallet, getSolPrice } = require('./rpc');
const cfg = require('../../config');
const log = require('../utils/logger').forTag('JUPITER');

const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL  = 'https://quote-api.jup.ag/v6/swap';
const WSOL_MINT         = 'So11111111111111111111111111111111111111112';

// ─── Price ───────────────────────────────────────────────────────────────────

/**
 * Get token price in USD via Jupiter.
 * Returns null if token is not listed yet (common for brand new tokens).
 */
async function getTokenPrice(mintAddress) {
  try {
    const resp = await fetch(
      `${cfg.jupiterPriceUrl}?ids=${mintAddress}&vsToken=USDC`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.data?.[mintAddress]?.price || null;
  } catch (err) {
    log.debug(`Jupiter price unavailable for ${mintAddress}:`, err.message);
    return null;
  }
}

// ─── Quote ───────────────────────────────────────────────────────────────────

async function getSwapQuote(inputMint, outputMint, amountLamports) {
  const solPrice = await getSolPrice();
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount:          amountLamports.toString(),
      slippageBps:     cfg.slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });

    const resp = await fetch(`${JUPITER_QUOTE_URL}?${params}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Quote HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    return await resp.json();
  } catch (err) {
    log.error('getSwapQuote error:', err.message);
    return null;
  }
}

// ─── Buy (SOL → Token) ───────────────────────────────────────────────────────

/**
 * Execute a real buy via Jupiter.
 * tradeSizeUSD is converted to SOL lamports.
 * Returns { txSignature, tokensReceived, priceUSD } or null on failure.
 */
async function executeBuySwap(mintAddress, tradeSizeUSD) {
  if (cfg.paperTrade) throw new Error('executeBuySwap called in paper trade mode');

  const solPrice = await getSolPrice();
  const solAmount   = tradeSizeUSD / solPrice;
  const lamports    = Math.floor(solAmount * 1e9);

  log.info(`Buy: ${tradeSizeUSD} USD = ${solAmount.toFixed(4)} SOL = ${lamports} lamports`);

  const quote = await getSwapQuote(WSOL_MINT, mintAddress, lamports);
  if (!quote) return null;

  const wallet = getWallet();
  const conn   = getConnection();

  const swapResp = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse:         quote,
      userPublicKey:         wallet.publicKey.toString(),
      wrapAndUnwrapSol:      true,
      prioritizationFeeLamports: cfg.priorityFeeBuy,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!swapResp.ok) {
    const text = await swapResp.text();
    throw new Error(`Swap HTTP ${swapResp.status}: ${text.slice(0, 200)}`);
  }

  const { swapTransaction } = await swapResp.json();

  // Deserialize, sign, send
  const { VersionedTransaction } = require('@solana/web3.js');
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx    = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight:       false,
    maxRetries:          2,
    preflightCommitment: 'confirmed',
  });

  log.info(`Buy tx sent: ${sig}`);

  // Wait for confirmation
  const confirmation = await conn.confirmTransaction(sig, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`Buy tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  const tokensReceived = Number(quote.outAmount) / 1e6; // 6 decimals
  const priceUSD       = (lamports / 1e9 * solPrice) / tokensReceived;

  log.info(`Buy confirmed: ${tokensReceived.toFixed(2)} tokens @ $${priceUSD.toFixed(8)}`);

  return {
    txSignature:   sig,
    tokensReceived,
    priceUSD,
    solSpent:      solAmount,
    lamportsSpent: lamports,
  };
}

// ─── Pre-sign sell transaction ────────────────────────────────────────────────

/**
 * Build and sign a sell transaction for a given percentage of tokens.
 * The signed transaction bytes are stored and sent later via Jito bundle.
 * Returns the signed serialized transaction bytes.
 */
async function buildPresignedSell(mintAddress, tokenAmount, percentage) {
  const { VersionedTransaction } = require('@solana/web3.js');
  const tokensToSell   = Math.floor(tokenAmount * (percentage / 100) * 1e6); // base units
  if (tokensToSell <= 0) return null;

  const wallet = getWallet();

  const quote = await getSwapQuote(mintAddress, WSOL_MINT, tokensToSell);
  if (!quote) return null;

  const swapResp = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse:         quote,
      userPublicKey:         wallet.publicKey.toString(),
      wrapAndUnwrapSol:      true,
      prioritizationFeeLamports: cfg.priorityFeeSell, // MAXIMUM on sells
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!swapResp.ok) return null;

  const { swapTransaction } = await swapResp.json();
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx    = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  log.debug(`Pre-signed sell built: ${percentage}% of ${mintAddress.slice(0, 8)}`);

  return {
    serialized:  Buffer.from(tx.serialize()),
    percentage,
    tokensToSell,
    builtAt:     Date.now(),
    quoteOut:    Number(quote.outAmount),
  };
}

module.exports = { getTokenPrice, getSwapQuote, executeBuySwap, buildPresignedSell };
