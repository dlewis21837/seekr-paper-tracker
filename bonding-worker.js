// Standalone bonding/migration scanner. Deploy as a separate Worker after configuring a trusted feed.
// Feed contract: JSON {tokens:[{mint,marketCapUsd,bondingProgress,migratedAt,
// liquidityUsd,priceUsd,buys5m,sells5m,buyVolumeUsd5m,sellVolumeUsd5m,
// uniqueBuyers5m,top10Pct,creatorPct,observedAt}]}.
// Never send buy recommendations on stale, missing, or unverified data.
const MAX_AGE_MS = 90_000;
const MIN_CAP = 20_000, MAX_CAP = 250_000;
const memory = new Map(); // local dev only; production dedupe uses KV
const n = v => v === null || v === undefined || v === '' ? NaN : Number(v);
const valid = v => Number.isFinite(v);
const safe = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mintOK = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export function evaluate(t, previous, now = Date.now()) {
  const mint = t.mint;
  if (!mintOK(mint)) return {ok:false,reason:'invalid mint'};
  const cap = n(t.marketCapUsd), liq = n(t.liquidityUsd), price = n(t.priceUsd);
  const progress = n(t.bondingProgress), migrated = Date.parse(t.migratedAt || '');
  const age = now - Date.parse(t.observedAt || '');
  const post = valid(migrated) && now >= migrated && now - migrated <= 15*60_000;
  const pre = valid(progress) && progress >= 80 && progress <= 100 && !valid(migrated);
  if (!pre && !post) return {ok:false,reason:'outside bonding/migration window'};
  if (!valid(age) || age < 0 || age > MAX_AGE_MS) return {ok:false,reason:'stale feed'};
  if (![cap,liq,price].every(valid) || cap < MIN_CAP || cap > MAX_CAP || liq < 10000 || price <= 0) return {ok:false,reason:'cap/liquidity/price'};
  const buys=n(t.buys5m), sells=n(t.sells5m), bv=n(t.buyVolumeUsd5m), sv=n(t.sellVolumeUsd5m), unique=n(t.uniqueBuyers5m);
  if (![buys,sells,bv,sv,unique].every(valid) || [buys,sells,bv,sv,unique].some(x=>x<0)) return {ok:false,reason:'missing trade metrics'};
  if (buys < 20 || unique < 12 || bv < 3000 || bv < sv*1.3 || (bv-sv) < 1500) return {ok:false,reason:'insufficient net demand'};
  if (valid(n(t.top10Pct)) && n(t.top10Pct)>45) return {ok:false,reason:'holder concentration'};
  if (valid(n(t.creatorPct)) && n(t.creatorPct)>5) return {ok:false,reason:'creator concentration'};
  // Require two observations to avoid one-shot wash-volume spikes.
  if (!previous || now-previous.at > 5*60_000 || now-previous.at < 10_000) return {ok:false,reason:'awaiting second observation'};
  if (unique < previous.unique || bv-sv < previous.net*0.7 || price < previous.price*0.93) return {ok:false,reason:'momentum/absorption not sustained'};
  return {ok:true,reason:post?'recent migration':'approaching bonding',net:bv-sv,cap,liq,price,unique};
}
export default {
 async fetch(req,env,ctx) {
   const path = new URL(req.url).pathname;
   if (path === '/status') return Response.json({build:'bonding-v1',configured:!!(env.FEED_URL && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.BONDING_KV),mode:'paper-alerts',note:'not an auto-trader'});
   if (path !== '/run') return new Response('Bonding scanner: /status');
   if (!env.RUN_SECRET || req.headers.get('authorization') !== 'Bearer '+env.RUN_SECRET) return new Response('Unauthorized',{status:401});
   return scan(env);
 },
 async scheduled(_,env,ctx) {ctx.waitUntil(scan(env));}
};
async function scan(env) {
 if (!env.FEED_URL || !env.BONDING_KV) return Response.json({ok:false,error:'FEED_URL and BONDING_KV required'}, {status:503});
 let response;
 try { response = await fetch(env.FEED_URL,{headers:env.FEED_TOKEN?{'Authorization':'Bearer '+env.FEED_TOKEN}:{},signal:AbortSignal.timeout(12000)}); }
 catch(e) {return Response.json({ok:false,error:'feed unreachable'},{status:502});}
 if (!response.ok) return Response.json({ok:false,error:'feed HTTP '+response.status},{status:502});
 const data=await response.json();
 if (!Array.isArray(data.tokens)) return Response.json({ok:false,error:'invalid feed schema'},{status:502});
 let evaluated=0, sent=0, errors=0;
 for (const t of data.tokens.slice(0,300)) {
   if (!mintOK(t.mint)) continue;
   evaluated++;
   const key='candidate:'+t.mint, sentKey='sent:'+t.mint;
   const previous=await env.BONDING_KV.get(key,'json');
   const result=evaluate(t,previous);
   const now=Date.now();
   const bv=n(t.buyVolumeUsd5m), sv=n(t.sellVolumeUsd5m);
   if (valid(bv)&&valid(sv)&&valid(n(t.priceUsd))&&valid(n(t.uniqueBuyers5m))) {
     await env.BONDING_KV.put(key,JSON.stringify({at:now,unique:n(t.uniqueBuyers5m),net:bv-sv,price:n(t.priceUsd)}),{expirationTtl:1800});
   }
   if (!result.ok || await env.BONDING_KV.get(sentKey)) continue;
   // Set marker only after Telegram confirms delivery. Race-free production needs a Durable Object lock.
   const link='https://dexscreener.com/solana/'+t.mint;
   const msg='<b>🧪 Bonding momentum — PAPER ONLY</b>\n'+safe(result.reason)+'\nCap: $'+Math.round(result.cap).toLocaleString()+
     ' | Liquidity: $'+Math.round(result.liq).toLocaleString()+'\n5m net buy flow: $'+Math.round(result.net).toLocaleString()+
     ' | unique buyers: '+result.unique+'\nCA: <a href="'+link+'">'+safe(t.mint)+'</a>\nNot a verified buy signal.';
   if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) continue;
   try {
     const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
       method:'POST',headers:{'content-type':'application/json'},
       body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:msg,parse_mode:'HTML',disable_web_page_preview:true})});
     const out=await r.json();
     if (!r.ok || !out.ok) {errors++;continue;}
     await env.BONDING_KV.put(sentKey,'1',{expirationTtl:7*86400}); sent++;
   } catch {errors++;}
 }
 return Response.json({ok:true,evaluated,sent,errors,at:new Date().toISOString()});
}
