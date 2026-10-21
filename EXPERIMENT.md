# PumpPortal live observation experiment

This separate Worker receives live launches and migrations. It never calls a trading API and does not need a wallet private key. Its optional swarm observations are not safety-cleared buy alerts. The existing production scanner is unaffected by deploying this separate configuration.

## What has been verified

A temporary unauthenticated PumpPortal WebSocket connected successfully and received 11 creation events over 18 seconds on October 20, 2026 Pacific. That test was closed afterward; it is not a running hosted service. No paid trade subscription was made. Node tests validate parsing, SOL units, budget defaults, observation deduplication, DST-aware alert hours, and the existing detector tests. Cloudflare deployment and funded trade streaming are not yet verified.

## Deploy free discovery first

Create a separate Cloudflare Worker from this repository's `momentum-swarm-v42` branch. Use deploy command:

```sh
npx wrangler deploy --config wrangler.experiment.jsonc
```

The Worker name is `solana-swarm-experiment`. Existing secrets on another Worker are not inherited. The configuration enables only free launch/migration discovery: trade-event limit is zero and Telegram is off. `/status` shows live connection state, counters, up to 20 recent discoveries and up to 100 swarm observations. A one-minute cron/alarm is a recovery heartbeat; token events themselves arrive through one persistent WebSocket. Outside 5 a.m.–8 p.m. Pacific the listener disconnects.

Cloudflare outbound WebSockets do not hibernate, so Cloudflare runtime/storage usage may incur hosting costs. Free PumpPortal discovery does not mean all hosting is free. No hosting or data service was purchased by this change.

## Enable metered observation after configuration

1. Create a **dedicated experiment wallet/API key** at https://pumpportal.fun/trading-api/setup/ . Save the private key securely yourself. The provider API key is trade-capable even though this code never trades; do not paste it into chat or GitHub.
2. PumpPortal requires at least 0.02 SOL in the linked wallet for trade subscriptions. This is provider data funding, not a token purchase. Use only funds set aside for the experiment.
3. Add the API key as the Cloudflare secret `PUMPPORTAL_API_KEY` on this separate Worker.
4. Set `DAILY_TRADE_EVENT_LIMIT` to a deliberate positive limit. The implementation caps this at 10,000 received trade events per UTC day; default 0 disables metered subscriptions. PumpPortal documents 0.01 SOL per 10,000 trade events. This software cutoff is NOT a guaranteed billing cap: buffered events, provider rounding, other consumers of the same key and billing policy can affect charges. Keep a small dedicated balance and do not use the key elsewhere.
5. For Telegram observations, copy your existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` into secrets for this Worker and set `EXPERIMENT_TELEGRAM_ENABLED=true`. Every message is explicitly labeled EXPERIMENT and safety not evaluated. No messages are sent until this opt-in is configured.

## Experiment scope and limitations

Subscribe to at most 50 newly discovered or migrated tokens for up to 15 minutes each. Status exposes dropped-token counts. This is a bounded pilot, NOT every Solana coin: tokens already trading before startup, tokens outside tracked venues, capacity overflows and late resurgences can be missed. Expand or change the provider only after measuring event volume and cost. A 10,000-event budget may run out quickly.

After each subscription or reconnect, warm up for two full minutes, then compare consecutive one-minute windows on each trade. Default experimental conditions: 8 distinct buying wallets, 1.5x acceleration in buyers and buy SOL, 5 newly active buyers, at least 5 SOL buying and 2 SOL net buying, buy/sell SOL ratio 1.5x, rising net demand, at most 35% of buy SOL from any one wallet, and 0.5% price response. These are starting hypotheses, not calibrated performance claims.

All amounts and price ratios are in SOL, not USD. Timestamping uses local receipt time because blockchain event timestamps are not established by this adapter. Distinct wallet addresses do not prove independent control. Malformed trades, buffer overflow, reconnect warm-up and coverage gaps suppress observations. No Rugcheck evaluation is performed here, so observations must not be confused with the main scanner's safety-cleared candidate flow.

Do not count this experiment as successful just because a launch arrives. Verify trade messages, distinct buyer counts, subscription health, dropped-token counts, budget use, observation latency and later coin outcomes. Automated post-alert outcome tracking is not implemented in this listener.

Disable by setting `EXPERIMENT_ENABLED=false`; the next heartbeat closes the feed. Provider errors and connection URLs are not logged to avoid exposing keys.

Run all correctness tests:

```sh
node --test swarm.test.mjs worker.test.mjs pumpportal-experiment.test.mjs
```
