import { stateGet, statePut } from './scanner-base.mjs';
const WEEK = 7 * 86400000;
const INTERVAL = 3 * 60000;
const MAX_REQUESTS = 2200;
export function allowance(state, now) {
  if (state.startedAt && now >= state.startedAt + WEEK) return 'Seven-day feed trial finished';
  if (state.requests >= MAX_REQUESTS) return 'Free-feed request budget exhausted';
  if (state.nextAt && now < state.nextAt) return 'Feed request cooldown';
  return null;
}
export function extractCandidates(data) {
  if (data?.status !== 'success' || !Array.isArray(data.data)) throw new Error('Unexpected Solana Tracker search response');
  return [...new Set(data.data.filter(t => t.market === 'pumpfun-amm' && t.quoteToken === 'So11111111111111111111111111111111111111112' && Number(t.marketCapUsd) >= 20000 && Number(t.marketCapUsd) <= 75000 && Number(t.liquidityUsd) >= 15000)
    .map(t => t.mint).filter(t => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t || '')))];
}
export async function discover(env) {
  if (!env.SOLANATRACKER_API_KEY) throw new Error('Missing SOLANATRACKER_API_KEY secret');
  const now = Date.now();
  const state = JSON.parse(await stateGet(env,'free_feed_budget') || '{}');
  const blocked = allowance(state,now);
  if (blocked) return {source:'solana-tracker-free',candidates:[],skipped:blocked,budget:state};
  // Reserve requests before network I/O. Failed requests and manual runs count too.
  state.startedAt ||= now;
  state.requests = (state.requests || 0) + 1;
  state.nextAt = now + INTERVAL;
  await statePut(env,JSON.stringify(state),'free_feed_budget');
  const url = new URL('https://data.solanatracker.io/search');
  for (const [k,v] of Object.entries({market:'pumpfun-amm',minMarketCap:20000,maxMarketCap:75000,minLiquidity:15000,sortBy:'volume_5m',sortOrder:'desc',limit:100})) url.searchParams.set(k,String(v));
  const response = await fetch(url,{headers:{'x-api-key':env.SOLANATRACKER_API_KEY},signal:AbortSignal.timeout(15000)});
  if (!response.ok) {
    // Auth/quota problems stop calls for remainder of the trial; 429 waits 15m.
    if ([401,402,403].includes(response.status)) state.nextAt = state.startedAt + WEEK;
    else if (response.status === 429) state.nextAt = now + 15*60000;
    await statePut(env,JSON.stringify(state),'free_feed_budget');
    throw new Error(`Solana Tracker HTTP ${response.status}`);
  }
  return {source:'solana-tracker-free',candidates:extractCandidates(await response.json()),budget:state};
}
