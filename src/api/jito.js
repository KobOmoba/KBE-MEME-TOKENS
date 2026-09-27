/**
 * Jito Bundle Execution — V3 §8.2
 *
 * Exit transactions are submitted as Jito bundles.
 * Jito processes bundles at the TOP of the Solana block — ahead of all
 * regular transactions. Target: 2-3 seconds from trigger to confirmed sell.
 *
 * Spec §8.3: sells ALWAYS use 5,000,000 lamports priority (maximum).
 * This is hardcoded here, not taken from config, to prevent it being
 * accidentally lowered.
 */

const { getConnection, getWallet } = require('./rpc');
const cfg = require('../../config');
const log = require('../utils/logger').forTag('JITO');

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13X5ta1R',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'r21Gamwd9DtyjHeGywsneoQYR39C1VDwrw7tWxHAwh6',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
];

// ─── Build tip transaction ────────────────────────────────────────────────────

async function buildTipTransaction() {
  const { SystemProgram, Transaction } = require('@solana/web3.js');
  const { PublicKey } = require('@solana/web3.js');
  const conn   = getConnection();
  const wallet = getWallet();

  // Pick a random tip account from the Jito list
  const tipAccount = new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
  );

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey:   tipAccount,
      lamports:   cfg.jitoTipLamports,
    })
  );

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash  = blockhash;
  tx.feePayer         = wallet.publicKey;
  tx.sign(wallet);

  return Buffer.from(tx.serialize());
}

// ─── Submit bundle ────────────────────────────────────────────────────────────

/**
 * Submit a Jito bundle containing one or more pre-signed transactions.
 * The tip transaction is automatically prepended.
 *
 * @param {Buffer[]} serializedTxs — array of signed transaction buffers
 * @returns {{ bundleId: string, success: boolean }}
 */
async function submitBundle(serializedTxs) {
  try {
    const tipTx   = await buildTipTransaction();
    const allTxs  = [tipTx, ...serializedTxs];

    // Jito expects base64-encoded transactions
    const encoded = allTxs.map(tx => tx.toString('base64'));

    const resp = await fetch(cfg.jitoEndpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'sendBundle',
        params:  [encoded],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      log.error(`Jito HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return { success: false, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();

    if (data.error) {
      log.error('Jito RPC error:', data.error);
      return { success: false, error: data.error.message };
    }

    const bundleId = data.result;
    log.info(`Jito bundle submitted: ${bundleId}`);
    return { success: true, bundleId };

  } catch (err) {
    log.error('submitBundle error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Execute presigned sell via Jito ─────────────────────────────────────────

/**
 * Fire a presigned sell transaction via Jito bundle.
 * Falls back to direct RPC send if Jito endpoint fails.
 *
 * @param {Buffer} serializedTx — the presigned sell transaction
 * @param {string} reason — for logging (TIER1, TIER2, STOP_LOSS, TIME_EXIT)
 * @returns {{ success: boolean, txSignature?: string, method: 'jito'|'rpc' }}
 */
async function firePresignedSell(serializedTx, reason) {
  const start = Date.now();
  log.info(`Firing ${reason} sell via Jito bundle...`);

  const result = await submitBundle([serializedTx]);

  if (result.success) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    log.info(`${reason} Jito bundle confirmed in ${elapsed}s — bundleId: ${result.bundleId}`);
    return { success: true, bundleId: result.bundleId, method: 'jito', elapsed };
  }

  // Jito failed — fall back to direct RPC send
  log.warn(`Jito failed (${result.error}), falling back to direct RPC send...`);
  try {
    const conn = getConnection();
    const sig  = await conn.sendRawTransaction(serializedTx, {
      skipPreflight: true,
      maxRetries:    3,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    log.info(`${reason} fallback RPC send: ${sig} (${elapsed}s)`);
    return { success: true, txSignature: sig, method: 'rpc', elapsed };
  } catch (err) {
    log.error(`${reason} fallback RPC also failed:`, err.message);
    return { success: false, error: err.message, method: 'rpc_failed' };
  }
}

module.exports = { submitBundle, firePresignedSell };
