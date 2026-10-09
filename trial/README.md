# Low-cap PumpSwap simulation trial

Independent Cloudflare Worker. Main scanner files and deployment configuration are unchanged. This worker places no trades, accepts no wallet key and sends no Telegram messages. It records at most 100 simulated entries, with at most 10 open at a time and one new entry per scan. Authentication is required for results and manual scans.

## Initial experimental settings

- PumpSwap only, Solana only, SOL quote only; $20k–$75k reported market cap (no FDV substitution).
- $15k liquidity minimum, liquidity at least 10% of market cap, pool at least ten minutes old.
- Five-minute volume at least $3k, at least 20 buys, buy/sell count ratio at least 1.3, five-minute change +3% to +35%.
- Existing Rugcheck safety review must pass. Missing reports fail closed. These checks cannot guarantee safety, identify all insiders or validate meme identity.
- Must qualify across two scans 2–10 minutes apart, same pool, price down no more than 5%, liquidity down no more than 10%.
- Entries only 5am–8pm America/Los_Angeles. Open positions continue being sampled overnight.
- Simulated $100 stake equivalent: -30% stop, half sold at 2x, remaining half trails 35%; close after 24h. Two percent adverse fill on entry and exit. Gap-through-stop prices are used as observed, not fixed at the stop.

Discovery now uses Solana Tracker free REST token search, restricted to pumpfun-amm, SOL quote, $20k–$75k cap and $15k liquidity. One request per active three-minute slot: about 2,100 over seven days, capped at 2,200 attempts. The seven-day timer starts at the first authorized feed attempt. Manual runs obey the same cooldown. No streaming or paid-plan subscription. No automatic fallback: results stay attributable to this feed. Top 100 by five-minute volume are sampled, and only four candidates get detailed checks each scan; this does not cover every launch. Token-search schema and market filtering still require validation with an actual account key.

DexScreener supplies detailed market checks and sampled position prices; Rugcheck supplies safety reports. Their own limits still apply. Existing helper budgets are independent of the main worker but upstream IP/account quotas can overlap. The seven-day cutoff stops Solana Tracker discovery; open simulated positions continue being sampled through their normal expiry.

Results are snapshots, not backtests or executable P&L. Polling can miss intraperiod highs, stops and liquidity loss. Fees beyond the stated adverse-fill model are not included. Missing prices stay unresolved with a priceError and lastCheckedAt; count these separately rather than as wins. Evaluate all 100 entries, realized results, open value, unresolved losses and maximum drawdown before considering live use. A profitable sample is not proof of future returns.

## Deploy independently

1. Run `node --test trial/trial.test.mjs` at repository root.
2. Install existing dev dependencies using `npm install` and authenticate Wrangler to the intended Cloudflare account.
3. Create a free Data API key at https://www.solanatracker.io/account/data-api (no paid subscription). Store it with `npx wrangler secret put SOLANATRACKER_API_KEY --config trial/wrangler.jsonc`. Do not paste it into chat or commit it. Set a new random API secret: `npx wrangler secret put RUN_KEY --config trial/wrangler.jsonc`.
4. Deploy `npx wrangler deploy --config trial/wrangler.jsonc`. This creates a separate worker and storage namespace.
5. Request `/status` and `/results` using `Authorization: Bearer <RUN_KEY>`. Manual scans use POST `/run` with the same header. Never place this secret in a URL.
6. Confirm scheduled scans complete, safety providers work, and two-scan entries are recorded. To stop the trial, remove its cron schedule or disable the separate worker.

No deployment has been performed by creating these files. `scanner-base.mjs` is a frozen copy of the checked-in scanner with named helper exports, so main changes cannot silently alter trial behavior. No alert delivery is wired yet.
