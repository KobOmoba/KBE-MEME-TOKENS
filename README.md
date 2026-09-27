# AariNAT Meme Token Sniper — V4

**AariNAT Company Limited | Operator: Bayo | RC-1732521**

---

## What Changed in V4

| Bug / Task | Fix |
|---|---|
| Pump.fun API blocked (530/403) | Solana WebSocket `onLogs` — no Pump.fun API needed |
| 54 crash loop | `uncaughtException` + `unhandledRejection` handlers. WebSocket auto-reconnect. |
| `paperTrade` flag not set on positions | Explicitly set in `buyer.js` `buildPosition()` |
| `savePaperStats` missing from sell path | Called in `seller.js` on every sell |
| `stopLossAlerted` locking out retries | Reset to `false` on failed sell in `seller.js` |
| MCap gate passes when `fdv=0` | Explicit `null/undefined/0/NaN` check before range check |
| Age gate after enrichment (wasted RPC calls) | Age gate is now Gate 1 — fires before any API call |
| `executeBuy` gated on `autoTradeEnabled` for paper trades | Paper and live are separate code paths |
| 999% stop loss workaround | Replaced by correct 1.5x moon bag rule — only after both tiers |
| Stop loss before tiers hit | Stop loss only fires when `tier1Sold && tier2Sold` are both `true` |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/KobOmoba/KBE-MEME-TOKENS.git
cd KBE-MEME-TOKENS
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env   # Fill in RPC_ENDPOINT, HELIUS_API_KEY, TELEGRAM_*
```

Minimum required to start paper trading:
- `RPC_ENDPOINT` — Helius or Triton private endpoint
- `RPC_WS_ENDPOINT` — WebSocket version of the same endpoint
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`

### 3. Run paper trading first

```bash
npm start
# or
node index.js
```

`PAPER_TRADE=true` is the default. **Do not change this until paper profit is confirmed.**

### 4. PM2 for production

```bash
npm install -g pm2
pm2 start index.js --name scanner --max-memory-restart 400M
pm2 logs scanner
pm2 monit
```

---

## Entry Rules (all non-negotiable)

| Gate | Condition | Reject if |
|---|---|---|
| 1 — Age | Token age at detection | ≥ 5 minutes old |
| 2 — MCap | Market capitalisation | Outside $25k–$35k, or null/zero |
| 3 — Liquidity | USD liquidity | Below $10,000 |
| 4 — Red flags | Mint/freeze authority, dev dump | Any present |
| 5 — Concentration | Top 10 wallet % | > 30% without both override conditions |
| 6 — Score | Score out of 100 | Below 65 |

## Exit Rules (hard — never override)

| Trigger | Action |
|---|---|
| 2x from entry | Sell 50% — principal recovered |
| 4x from entry | Sell 30% — locked profit |
| Price falls to 1.5x (after both tiers) | Sell remaining 20% moon bag |
| 15 min without hitting 2x | Exit 100% immediately |

---

## Architecture

Three completely independent loops. **Never merge them.**

- **Loop 1 — Scanner** (WebSocket, event-driven): detects new tokens via `connection.onLogs(PUMP_FUN_PROGRAM_ID)`. Zero dependency on Pump.fun's API.
- **Loop 2 — Position Monitor** (every 10s): checks all open positions for exit triggers.
- **Loop 3 — Pre-Sign Refresh** (every 45s): rebuilds expiring pre-signed sell transactions.

---

## Paper Stats

Stats written to `data/paper_stats.json` after every trade. Check your P&L:

```bash
cat data/paper_stats.json
```

---

## Go Live Checklist

- [ ] Paper trading running with zero bugs
- [ ] At least 20 paper trades completed
- [ ] Paper P&L positive
- [ ] `WALLET_PRIVATE_KEY` set in `.env` (never committed to git)
- [ ] Set `PAPER_TRADE=false` and `AUTO_TRADE=true` in `.env`
- [ ] PM2 running with memory limit
- [ ] Telegram notifications confirmed working

---

*AariNAT Company Limited | Spec V3 | 9 confirmed commits synced*
