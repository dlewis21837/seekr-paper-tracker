Seekr, Raydium, Robinhood Chain, and BNB Chain tracker deployment.

Required Cloudflare secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `BITQUERY_TOKEN` (enables Robinhood Chain Pools.trade and BNB Chain Four.meme launch monitoring)

BNB candidates must reach a separate score threshold and pass GoPlus honeypot, sellability, source-code, transfer-control, balance-control, and tax checks before an alert is sent.

The worker is read-only and never receives wallet keys or places trades.
