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
  // V4.2 (Bayo decision): NO entry floor. Buy as early as the safety gates allow. To restore the
  // old $25k floor put MCAP_MIN=25000 and MIN_LIQUIDITY=10000 in .env.
  mcapMin:                 process.env.MCAP_MIN !== undefined ? parseFloat(process.env.MCAP_MIN) : 0,
  mcapMax:                 35000,   // V3 §2.2 — $35k max (was $5M in V1)
  // Bonding-curve liquidity at launch is only ~$500-1,500, so a $10k floor made early entry impossible.
  // A $2 trade moves such a curve by ~1-2%, so $500 is enough for the trade size in use.
  minLiquidityForBuy:      process.env.MIN_LIQUIDITY !== undefined ? parseFloat(process.env.MIN_LIQUIDITY) : 500,
  maxOpenPositions:        parseInt(process.env.MAX_OPEN || '10', 10),   // stops a flood of paper buys
  minScore:                65,      // V3 §2.6 — only enforced when scoreGateEnabled
  // V4.2 (Bayo decision): score is ADVISORY by default. It is still computed and stored on every
  // paper trade so win-rate by score can be measured. Turn back on with SCORE_GATE=on in .env.
  scoreGateEnabled:        process.env.SCORE_GATE === 'on',
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
  // V4.2 (Bayo decision): once BOTH tiers are done (80% sold, stake + profit banked), the last
  // 20% is protected by a TRAILING stop: sell if price falls moonBagTrailPct% below its ATH
  // since entry. Set moonBagStopMode:'fixed' to go back to the 1.5x-from-entry floor.
  moonBagStopMode:      'trail',
  moonBagTrailPct:      12,
  moonBagStopMultiple:  1.5,   // only used when moonBagStopMode === 'fixed'   // exit final 20% if price falls back to 1.5x from entry
  maxHoldMinutes:       15,    // time exit: if no 2x in 15 min → exit 100%

  // ─── WATCHLIST (V4.2) ───────────────────────────────────────────────────────
  watchIntervalMs:   5000,     // re-check every watched token this often (feed-priced: costs no RPC credits)
  allowUnverifiedInPaper: true, // paper may trade when RPC is down (holders unverified, flagged). Live never does.
  maxWatchlist:      400,
  shadowTrackMinutes: 30,      // keep following tokens that reached $25k after the 5-min buy cutoff (data only, never bought)      // safety cap for RAM / RPC on the 956MB server
  pumpPortalEnabled: process.env.PUMPPORTAL !== 'off',   // trade feed + backup detection
  watchLogFile:      './data/watch_log.jsonl',           // per-token mcap trajectories (research data)

  // ─── PAPER REALISM (V4.2) ───────────────────────────────────────────────────
  // Paper fills used to be exact trigger prices with zero fees. Fees are modelled from the
  // same lamport settings the live bot uses; slippage haircut applied to every paper fill.
  paperSlippageBps:  500,      // 5% haircut on every paper buy and sell

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
  rpcWsEndpoint:    process.env.RPC_WS_ENDPOINT || '',   // Helius WS — LAST resort for log detection
  // Tier 2 log source (onLogs / logsSubscribe). Non-Helius by default; override in .env with any
  // Solana WebSocket you trust (a free-tier provider is more reliable than the public endpoint).
  logsWsEndpoint:   process.env.LOGS_WS_ENDPOINT || 'wss://api.mainnet-beta.solana.com',
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

// Human label for messages: "$25k–$35k" or "under $35k"
const _k = (n) => n >= 1000 ? `$${n / 1000}k` : `$${n}`;
module.exports.windowLabel = module.exports.mcapMin > 0 ? `${_k(module.exports.mcapMin)}–${_k(module.exports.mcapMax)}` : `under ${_k(module.exports.mcapMax)}`;
