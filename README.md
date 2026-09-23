Seekr, Raydium, and Robinhood Chain tracker deployment.

Required Cloudflare secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `BITQUERY_TOKEN` (enables Robinhood Chain Pools.trade launch monitoring)

The worker is read-only and never receives wallet keys or places trades.
