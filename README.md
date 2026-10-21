# Solana trade-swarm scanner — experimental replacement

This branch replaces the 9-point market score with a trade-level momentum trigger. It is a draft, not a verified live deployment or a validated profitable strategy. It never trades or holds wallet keys.

## Trigger

Compare the last complete minute with the preceding minute, anchored to evaluation time. Require at least 8 distinct buying addresses, 1.5x buyer acceleration, 5 newly active buyers, $750 of buying, 1.5x buy-dollar acceleration, $300 net buying, improving net demand, buy dollars at least 1.5x sell dollars, and at least 0.5% price rise during the current minute. No single buying address may contribute over 35% of buy dollars. These are explicit initial experimental thresholds, not calibrated probabilities or an optimal configuration.

Missing fields, stale trades (latest over 30 seconds old), mismatched token addresses, anomalous trades and truncated windows block the trigger. The public trade endpoint returns at most 300 trades. If those trades do not cover both minutes, the scanner reports the gap instead of treating a partial sample as acceleration. Distinct addresses do not prove independently controlled wallets; wallet clustering and funding-source analysis are not implemented.

## Safety and delivery

Existing Rugcheck, liquidity, authority, holder, insider and pool consistency checks remain mandatory. Copycat flags now block instead of merely warning. Only exact candidate base tokens quoted in SOL qualify. Market cap and age do not add points or impose an upper-cap veto; the liquidity/cap safety floor remains. A fresh same-pool observation after five seconds rejects price drops above 5% or liquidity drops above 10%. A signal older than one minute cannot be delivered.

Alerts include buyer acceleration, buy/sell dollars, token name and a clickable exact contract. A durable per-contract marker suppresses repeat alerts across Seekr and PumpSwap; available historical PumpSwap alerts are imported. Delivery followed by marker persistence has a crash window, so strict exactly-once delivery cannot be guaranteed. Older Seekr alerts have no complete historical deduplication ledger.

## Discovery and operating limits

Alternate public new-pool and trending-pool pages; retain a bounded 30-minute candidate watchlist. Seekr remains an additional nomination source. Raydium, Meteora, BNB and Robinhood remain disabled. Scan on a one-minute cron within 5 a.m.–8 p.m. America/Los_Angeles, with overlap protection, request governors and provider cooldowns. This is polling, not streaming: scanner runtime, page coverage, candidate limits and cooldowns can delay or miss a swarm. New pools alternate with trending pools and therefore have a nominal two-minute discovery cadence, not instantaneous detection. Public profile/boost fallback is biased and incomplete.

Paper trading and background outcome price polling are disabled to reserve provider budget. Existing outcome records remain accessible. Six discovery candidates use a batched pair lookup; Seekr watches up to four candidates per run, rotating failures. These bounds prevent runaway requests but do not provide whole-chain coverage.

## Deployment blocker

The production provider gateway currently reports HTTP 429 / Cloudflare 1015. Do not merge or advertise live swarm coverage until the deployed gateway can retrieve fresh trades and pairs reliably, the new build is observed at `/status`, and a non-sending end-to-end run verifies the path. Increasing cron frequency alone does not solve blocked feeds. A reliable authenticated streaming provider is still needed for comprehensive start-of-swarm coverage; no subscription has been purchased or credentials requested by this branch.

Required existing configuration: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `STATE` durable-object binding.

## Validation

Run `node --test swarm.test.mjs worker.test.mjs`. Thirteen tests cover positive acceleration; one-wallet repetition; whale concentration; sell pressure; steady activity; stale/malformed/wrong-token/future/anomalous/truncated feeds; duplicate trades; missing price response; cap-independent observations; SOL pool identity; safety and delivery deduplication; and provider cooldowns. These are synthetic correctness tests, not a backtest or proof of profitability.

API schema references: https://apiguide.geckoterminal.com/ and https://docs.dexscreener.com/api/reference .
