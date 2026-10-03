# Pump.fun near-graduation filter port — draft, not deployed

This is the filter engine for a separate alerts-only scanner. It is not a running scanner. Discovery, RPC validation, safety normalization, scheduling, and Telegram delivery still need wiring and authenticated integration testing.

Source: seekr-paper-tracker `worker.js`, commit d55690dd9b608d2819b885d84249da7e695a0bcb, build scanner-v34-paper-disabled-2026-10-01. Main Worker and its deployment configuration are unchanged.

## Initial settings

Near graduation means 80% to strictly below 100% of initial real bonding-curve tokens sold; the on-chain complete flag must still be false. This is an initial trial setting, not a validated profitable threshold. No fixed graduation market cap is assumed.

Carry over PumpSwap gates: $5,000 hourly volume, 20 hourly buys, 15 distinct hourly buyers, buy/sell ratio 1.1, momentum 8% (maximum of 5-minute, hourly and 6-hour change), maximum market cap $2M, 5-minute drop no worse than -15%, hourly drop no worse than -30%. The existing minimum score is **1**, not 7/9, 8/9, or 9/9. One deliberate fail-closed difference: the existing discovery gate bypasses the distinct-buyer minimum if reported buyers is zero/missing; this draft requires a known count >=15 rather than treating unknown buyers as a pass.

Carry over safety: largest circulating holder <=15%, top ten <=45%, creator <=5%, known insiders <=20%, no suspicious top holders or bundle/prior-creator-rug/danger flags, mint/freeze authorities revoked, transfer fee <=5%, Rugcheck normalized score <=49. Copycat and repeat-creator warnings retain current treatment; repeat creators subtract one score point. A name match does not prove token authenticity.

Pre-graduation adaptations: LP lock/burn checks become verification of the actual Pump program-owned bonding curve PDA derived for the exact mint, its discriminator, real reserves, and incomplete status. Exclude only its verified token custody account from holder concentration. $10,000 minimum and 5% reserve-to-market-cap gate use real quote reserves valued in USD, not virtual reserves or reported AMM liquidity. This is a new economic gate and requires measurement; it is not equivalent to post-graduation liquidity.

Confirmation takes two fresh observations 20–30 seconds apart. Reject a changed curve, graduation, more than 12% price decline or 20% real-reserve decline. Missing safety or market fields block; cumulative trades cannot be relabeled as hourly activity. Solana/SOL quote only, 5 a.m.–8 p.m. America/Los_Angeles, including daylight-saving changes.

## Required wiring

Solana Tracker documents `GET https://data.solanatracker.io/tokens/multi/graduating?markets=pumpfun&minCurve=80&maxCurve=99.99&limit=100`, with `x-api-key` authentication. Use this for candidate discovery, not proof of curve state. See https://docs.solanatracker.io/data-api/tokens/get-graduating-tokens . Its risk score is not interchangeable with Rugcheck's score. Its pool cumulative transaction fields cannot substitute for hourly counts. Confirm supported market spelling and metric schemas against authenticated responses before activation.

Configure `SOLANA_TRACKER_API_KEY` and a suitable `SOLANA_RPC_URL` as secrets in the new Worker. Telegram credentials also stay in secrets. Never add keys to source or messages. No credentials or Cloudflare deployment access were available when preparing this draft.

The adapter must obtain actual hourly trades, unique buyer counts and time-window price changes; derive and verify curve PDA with the current official Pump SDK/IDL; get current real reserves/initial configuration; verify mint linkage, quote and program; normalize fresh Rugcheck data and exact holder owners. Do not accept the normalized `verified` flag from a public webhook. Do not fabricate successful reports or suppress unknown metrics.

Runtime: separate named Worker, own Durable Object, provider budget, cooldown and persistent first-alert-per-mint delivery record. Start with one bounded poll per minute; at most 5 confirmations per pass, no overlapping runs, no accumulating stale queue. A one-minute poll can miss fast graduation; move to a live feed only after validating provider coverage and costs. Separate Worker does not eliminate account-level provider limits: capacity must be reserved or isolated too.

Before sending, atomically reserve the mint in durable state, recheck hours and freshness, then send a clearly labeled PUMP.FUN PRE-GRADUATION alert with name, market cap, curve progress, warnings, and exact contract linked to its DexScreener page plus Pump.fun link. DexScreener may not yet index a pre-graduation token. A Telegram timeout is ambiguous: mark delivery uncertain rather than retrying automatically and risking duplicates. No auto-buying, paper tracking or daily reports.

Health endpoint must distinguish missing configuration, provider cooldown, stale feed, incomplete safety, rejected candidates, completed scans and delivery failures. Successful unit checks below do not establish live provider compatibility or trading effectiveness.

Run tests: `node --test pregraduate/filters.test.mjs`.
