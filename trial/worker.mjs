import { discover } from './solana-feed.mjs';
import {
  State,
  stateGet,
  statePut,
  getBestPair,
  getSolanaSafety,
  insidePacificWindow
} from './scanner-base.mjs';

export { State };

export const SOL = 'So11111111111111111111111111111111111111112';

export function gate(p, now = Date.now()) {
  const cap = Number(p?.marketCap);
  const liq = Number(p?.liquidity?.usd);
  const buys = Number(p?.txns?.m5?.buys);
  const sells = Number(p?.txns?.m5?.sells);
  const change = Number(p?.priceChange?.m5);
  const age = now - Number(p?.pairCreatedAt);

  return p?.chainId === 'solana' &&
    p?.dexId === 'pumpswap' &&
    p?.quoteToken?.address === SOL &&
    Number(p.priceUsd) > 0 &&
    cap >= 20000 && cap <= 75000 &&
    liq >= 15000 && liq / cap >= .1 &&
    Number(p?.volume?.m5) >= 3000 &&
    buys >= 20 && sells >= 0 &&
    buys / Math.max(1, sells) >= 1.3 &&
    change >= 3 && change <= 35 &&
    age >= 10 * 60000;
}

// Sampled prices, not executable fills.
// Apply 2% adverse fill on each side.
export function mark(t, price, now) {
  if (t.closedAt || !(price > 0)) return t;

  const x = price * .98 / t.entryPrice;
  t.peak = Math.max(t.peak, x);

  if (x <= .7) {
    t.realized += t.remaining * x;
    t.remaining = 0;
    t.reason = 'stop';
  } else {
    if (!t.tookHalf && x >= 2) {
      t.realized += .5 * x;
      t.remaining = .5;
      t.tookHalf = true;
    }

    if (
      (t.tookHalf && x <= t.peak * .65) ||
      now - t.entryAt >= 86400000
    ) {
      t.realized += t.remaining * x;
      t.remaining = 0;
      t.reason = t.tookHalf ? 'trail/timeout' : 'timeout';
    }
  }

  t.lastPrice = price;
  t.lastCheckedAt = now;
  t.multiple = t.realized + t.remaining * x;

  if (!t.remaining) t.closedAt = now;

  return t;
}

async function jsonGet(env, key, fallback) {
  return JSON.parse(
    await stateGet(env, key) || JSON.stringify(fallback)
 
