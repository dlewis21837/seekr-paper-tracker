import { State, stateGet, statePut, getSolanaMomentumPayloads, getBestPair, getSolanaSafety, insidePacificWindow } from './scanner-base.mjs';
export { State };
export const SOL = 'So11111111111111111111111111111111111111112';
export function gate(p, now = Date.now()) {
  const cap = Number(p?.marketCap), liq = Number(p?.liquidity?.usd);
  const buys = Number(p?.txns?.m5?.buys), sells = Number(p?.txns?.m5?.sells);
  const change = Number(p?.priceChange?.m5), age = now - Number(p?.pairCreatedAt);
  return p?.chainId === 'solana' && p?.dexId === 'pumpswap' && p?.quoteToken?.address === SOL &&
    Number(p.priceUsd) > 0 && cap >= 20000 && cap <= 75000 && liq >= 15000 && liq / cap >= .1 &&
    Number(p?.volume?.m5) >= 3000 && buys >= 20 && sells >= 0 && buys / Math.max(1, sells) >= 1.3 &&
    change >= 3 && change <= 35 && age >= 10 * 60000;
}
// Sampled prices, not executable fills. Apply 2% adverse fill on each side.
export function mark(t, price, now) {
  if (t.closedAt || !(price > 0)) return t;
  const x = price * .98 / t.entryPrice;
  t.peak = Math.max(t.peak, x);
  if (x <= .7) { t.realized += t.remaining * x; t.remaining = 0; t.reason = 'stop'; }
  else {
    if (!t.tookHalf && x >= 2) { t.realized += .5 * x; t.remaining = .5; t.tookHalf = true; }
    if ((t.tookHalf && x <= t.peak * .65) || now - t.entryAt >= 86400000) {
      t.realized += t.remaining * x; t.remaining = 0; t.reason = t.tookHalf ? 'trail/timeout' : 'timeout';
    }
  }
  t.lastPrice = price; t.lastCheckedAt = now; t.multiple = t.realized + t.remaining * x;
  if (!t.remaining) t.closedAt = now;
  return t;
}
async function jsonGet(env, key, fallback) { return JSON.parse(await stateGet(env, key) || JSON.stringify(fallback)); }
async function run(env) {
  const stub = env.STATE.get(env.STATE.idFromName('seekr')), token = crypto.randomUUID();
  const lease = await stub.fetch('https://state/acquire', {method:'POST', body:token}).then(r => r.json());
  if (!lease.acquired) return {skipped:'Already running'};
  const now = Date.now();
  env = {...env, _scanDeadline:now+140000, _dex:{cache:new Map(), confirmations:new Map(), sharedConfirmations:0, requests:0, cacheHits:0, throttled:0, priority:'discovery'}};
  const result = {at:new Date(now).toISOString(), mode:'SIMULATION', opened:[], errors:[]};
  try {
    const trades = await jsonGet(env, 'trial_trades', []);
    // Hard bound: at most 10 open positions and 100 total trial entries.
    for (const t of trades.filter(t => !t.closedAt)) {
      try {
        const p = await getBestPair(t.contract, 'pumpswap', 'solana', env);
        if (!p || p.pairAddress !== t.pairAddress || p.quoteToken?.address !== SOL) throw new Error('Original SOL pool missing');
        mark(t, Number(p.priceUsd), now);
        delete t.priceError;
      } catch(e) { t.priceError = String(e); result.errors.push({contract:t.contract,error:String(e)}); }
    }
    await statePut(env, JSON.stringify(trades), 'trial_trades');
    if (!insidePacificWindow()) result.skipped = 'Outside 5am–8pm Pacific entry window';
    else if (trades.length >= 100 || trades.filter(t => !t.closedAt).length >= 10) result.skipped = 'Trial capacity reached';
    else {
      const discovery = await getSolanaMomentumPayloads(env);
      result.discovery = discovery.source;
      const candidates = [];
      for (const payload of discovery.payloads) {
        const tokens = new Map((payload.included || []).map(t => [t.id,t.attributes]));
        for (const p of payload.data || []) {
          if (p.relationships?.dex?.data?.id !== 'pumpswap') continue;
          const id = p.relationships?.base_token?.data?.id;
          const contract = tokens.get(id)?.address || String(id || '').replace(/^solana_/, '');
          if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contract) && !trades.some(t => t.contract === contract)) candidates.push(contract);
        }
      }
      for (const contract of [...new Set(candidates)].slice(0, 4)) {
        if (Date.now()+35000 >= env._scanDeadline) break;
        try {
          const first = await getBestPair(contract,'pumpswap','solana',env);
          if (!gate(first)) continue;
          const safety = await getSolanaSafety(contract, env);
          if (!safety.passed) { result.errors.push({contract,error:safety.summary}); continue; }
          // Cross-scan confirmation, no blocking delay or old candidate queue.
          const observations = await jsonGet(env,'trial_observations',{});
          const prev = observations[contract];
          observations[contract] = {at:now,price:Number(first.priceUsd),liquidity:Number(first.liquidity.usd),pair:first.pairAddress};
          for (const k of Object.keys(observations)) if (now-observations[k].at > 10*60000) delete observations[k];
          await statePut(env,JSON.stringify(observations),'trial_observations');
          if (!prev || now-prev.at < 120000 || now-prev.at > 10*60000 || prev.pair !== first.pairAddress || Number(first.priceUsd) < prev.price*.95 || Number(first.liquidity.usd) < prev.liquidity*.9) continue;
          trades.push({contract,name:first.baseToken.name,pairAddress:first.pairAddress,entryAt:now,entryCap:first.marketCap,entryPrice:Number(first.priceUsd)*1.02,remaining:1,realized:0,peak:1,multiple:.98/1.02,safety:safety.summary});
          result.opened.push(contract);
          await statePut(env,JSON.stringify(trades),'trial_trades');
          break; // At most one new simulated entry per scan.
        } catch(e) { result.errors.push({contract,error:String(e)}); }
      }
    }
    result.ok = !result.errors.length;
  } catch(e) { result.ok=false; result.errors.push({error:String(e)}); }
  finally {
    result.completedAt = new Date().toISOString();
    try { await statePut(env,JSON.stringify(result),'trial_status'); }
    finally { await stub.fetch('https://state/release',{method:'POST',body:token}); }
  }
  return result;
}
export default {
  async fetch(req, env) {
    if (!env.RUN_KEY || req.headers.get('Authorization') !== `Bearer ${env.RUN_KEY}`) return new Response('Unauthorized',{status:401});
    const path = new URL(req.url).pathname;
    if (path === '/run' && req.method === 'POST') return Response.json(await run(env));
    if (path === '/status') return Response.json(await jsonGet(env,'trial_status',{}));
    if (path === '/results') return Response.json({mode:'SIMULATION',trades:await jsonGet(env,'trial_trades',[])});
    return new Response('Not found',{status:404});
  },
  async scheduled(controller, env, ctx) { ctx.waitUntil(run(env)); }
};
