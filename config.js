/**
 * AariNAT Meme Token Sniper — Configuration V4
 * ─────────────────────────────────────────────
 * OPERATOR: Bayo | AariNAT Company Limited
 *
 * DO NOT set paperTrade: false until paper trading shows consistent profit.
 * The spec is explicit: paper profit must come first.
 */

require('dotenv').config();

module.exports = {
  // ─── TRADING MODE ───────────────────────────────────────────────────────────
  // PITFALL FIX #1 / #6: paperTrade must be explicitly set in config AND
  // propagated to every position object. Both layers enforced.
  paperTrade: process.env.PAPER_OVERRIDE === 'true' || process.env.PAPER_TRADE !== 'false',
  autoTradeEnabled: process.env.AUTO_TRADE === 'true',   // Live trades need explicit opt-in

  // ─── ENTRY FILTERS ──────────────────────────────────────────────────────────
  // Spec §2 — all non-negotiable
  maxTokenAgeMinutes:      5,       // V3 §2.1 — tokens at/older than 5 min: auto-reject
  mcapMin:                 25000,   // V3 §2.2 — $25k min (was $50k in V1)
  mcapMax:                 35000,   // V3 §2.2 — $35k max (was $5M in V1)
  minLiquidityForBuy:      10000,   // V3 §2.3 — $10k min liquidity
  minScore:                65,      // V3 §2.6 — 65/100 minimum (was 80 in V1)
  maxWalletConcentration:  30,      // V3 §2.5 — top 10 wallets < 30% to pass
  devMaxHoldingPct:        10,      // V3 §2.5 — dev override: dev < 10% of supply
  devTransactionGraceMin:  3,       // V3 §2.5 — dev override: zero txns in first 3 min

  // ─── EXIT RULES ─────────────────────────────────────────────────────────────
  // Spec §7 — hard rules, never override
  tier1Multiple:        2.0,   // 2x → sell 50%
  tier1SellPct:         50,
  tier2Multiple:        4.0,   // 4x → sell 30%
  tier2SellPct:         30,
  moonBagPct:           20,    // remaining 20%
  // TASK 1 FIX: 1.5x moon bag stop REPLACES the 999% workaround in config.js line 56
  // The stop loss only fires AFTER BOTH tier1 AND tier2 have executed.
  // Before both tiers, only the 15-minute time exit applies.
  moonBagStopMultiple:  1.5,   // exit final 20% if price falls back to 1.5x from entry
  maxHoldMinutes:       15,    // time exit: if no 2x in 15 min → exit 100%

  // ─── POSITION SIZING ────────────────────────────────────────────────────────
  tradeSize:        2.00,    // USD equivalent (was $5-$10 in V1, fixed in commit 4)
  slippageBps:      1500,    // 15% slippage — required for meme tokens

  // ─── FEES ───────────────────────────────────────────────────────────────────
  priorityFeeBuy:        100000,     // lamports — high priority on buys
  priorityFeeSell:       5000000,    // lamports — MAXIMUM on sells (never less than buy)
  jitoTipLamports:       100000,     // ~0.0001 SOL Jito bundle tip

  // ─── NETWORK ────────────────────────────────────────────────────────────────
  // Never use public RPC. Must be Helius or Triton private endpoint.
  rpcEndpoint:      process.env.RPC_ENDPOINT   || '',
  rpcWsEndpoint:    process.env.RPC_WS_ENDPOINT || '',
  jitoEndpoint:     process.env.JITO_ENDPOINT  || 'https://mainnet.block-engine.jito.labs.io/api/v1/bundles',
  heliusApiKey:     process.env.HELIUS_API_KEY  || '',
  jupiterPriceUrl:  'https://price.jup.ag/v6/price',

  // ─── WALLET ─────────────────────────────────────────────────────────────────
  privateKey: process.env.WALLET_PRIVATE_KEY || '',  // Base58 encoded

  // ─── TELEGRAM ───────────────────────────────────────────────────────────────
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId:   process.env.TELEGRAM_CHAT_ID   || '',

  // ─── TIMING — THREE LOOPS ───────────────────────────────────────────────────
  // Spec §4 — three completely independent loops, never merged
  scanIntervalMs:      10000,   // Scanner loop: every 10 seconds
  monitorIntervalMs:   10000,   // Position monitor: every 10 seconds
  presignRefreshMs:    45000,   // Pre-sign refresh: every 45 seconds (before 60s expiry)

  // ─── PUMP.FUN ───────────────────────────────────────────────────────────────
  // Using WebSocket onLogs approach — bypasses Pump.fun HTTP API entirely.
  // This fixes the 530/403 blocking issue on the server IP.
  pumpFunProgramId:    '6EF8rrectrRdC4KjqW7GqK9Wz9hEndkbskZaZKzhW9Ep',
  raydiumProgramId:    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',

  // SOL mint address (for price lookups)
  solMint: 'So11111111111111111111111111111111111111112',

  // ─── PERSISTENCE ────────────────────────────────────────────────────────────
  positionsFile:    './data/positions.json',
  paperStatsFile:   './data/paper_stats.json',
  trackedFile:      './data/tracked.json',
};
