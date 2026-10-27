import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = await fs.readFile(new URL('./worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { marketPairsJson, getSolanaMomentumPayloads, selectBestPair, performMarketConfirmation };').toString('base64'));
const nativeFetch = globalThis.fetch;
function setup() {
  const data = new Map();
  const storage = { get: async k => data.get(k), put: async(k,v) => data.set(k,v), delete: async k => data.delete(k), transaction: async fn => fn(storage) };
  const state = new mod.State({storage});
  const gateway = {fetch: (url, options) => state.fetch(new Request(url, options))};
  return {data, state, env: {STATE: {idFromName: x => x, get: () => gateway}, _scanDeadline: Date.now()+150000, _dex: {cache:new Map(), confirmations:new Map(), requests:0, cacheHits:0, throttled:0}}};
}
async function route(state, path, body) { return state.fetch(new Request('https://state/'+path,{method:'POST',body:JSON.stringify(body)})).then(r=>r.json()); }
const token = '26cfppyAgj7e1XHkgPwaYv4L8QuDTwrVyD1mAquhpump';
const sol = 'So11111111111111111111111111111111111111112';
const payload = {data:[{attributes:{address:'pool1',base_token_price_usd:'0.01',market_cap_usd:'100000',reserve_in_usd:'30000',volume_usd:{h1:'20000'},transactions:{h1:{buys:200,sells:100}},price_change_percentage:{m5:'5',h1:'20'},pool_created_at:new Date().toISOString()},relationships:{base_token:{data:{id:'solana_'+token}},quote_token:{data:{id:'solana_'+sol}},dex:{data:{id:'pumpswap'}}}}],included:[{id:'solana_'+token,attributes:{name:'Example',symbol:'EX'}},{id:'solana_'+sol,attributes:{symbol:'SOL'}}]};
{
 const {state,data} = setup();
 const backoff=await route(state,'dex-backoff',{bucket:'discovery',retryAfterMs:18000});
 assert(backoff.retryAt-Date.now()<=30000);
 data.set('dex_global_next_at',Date.now()+2400000); // old release's global cooldown
 assert.equal((await route(state,'dex-permit',{bucket:'pairs'})).allowed,true);
 assert.equal((await route(state,'dex-permit',{bucket:'discovery'})).allowed,false);
 console.log('PASS: discovery cooldown isolated; legacy global cooldown migrated; Retry-After respected');
}
{
 const {env}=setup(); const urls=[];
 globalThis.fetch=async url=>{urls.push(String(url));return String(url).includes('dexscreener') ? new Response('error code: 1015',{status:429,headers:{'retry-after':'18'}}) : Response.json(payload);};
 const pairs=await mod.marketPairsJson(env,'https://api.dexscreener.com/tokens/v1/solana/'+token);
 assert.equal(pairs[0].marketDataSource,'geckoterminal');
 assert.equal(mod.selectBestPair(pairs,token,'pumpswap').pairAddress,'pool1');
 assert.equal(mod.selectBestPair(pairs,'wrong','pumpswap'),null);
 assert.equal(env._dex.marketFallbackRequests,1);
 console.log('PASS: real 429 shape triggers fallback with correct token, pool and trusted quote');
}
{
 const {env}=setup();
 globalThis.fetch=async url=>String(url).includes('dexscreener') ? new Response('',{status:429}) : new Response('',{status:503});
 await assert.rejects(()=>mod.marketPairsJson(env,'https://api.dexscreener.com/tokens/v1/solana/'+token),/Market providers unavailable/);
 console.log('PASS: both providers failing produces an error, never a clean result');
}
{
 const {env}=setup();
 globalThis.fetch=async url=>String(url).includes('dexscreener') ? new Response('',{status:429}) : Response.json(payload);
 const discovery=await mod.getSolanaMomentumPayloads(env);
 assert.equal(discovery.source,'geckoterminal'); assert.equal(discovery.payloads[0].data.length,1);
 console.log('PASS: discovery continues on alternate provider after DexScreener failure');
}
{
 const {env}=setup();
 globalThis.fetch=async url=>String(url).includes('dexscreener') ? new Response('',{status:429}) : Response.json(payload);
 const pair={chainId:'solana',dexId:'pumpswap',pairAddress:'pool1',baseToken:{address:token},quoteToken:{address:sol},priceUsd:'0.01',marketCap:100000,liquidity:{usd:30000},volume:{h1:20000},txns:{h1:{buys:200,sells:100}},priceChange:{m5:5,h1:20},pairCreatedAt:Date.now()};
 const timer=globalThis.setTimeout; globalThis.setTimeout=fn=>{fn();return 0;};
 try { const result=await mod.performMarketConfirmation({contract:token},pair,{dexId:'pumpswap',env}); assert.equal(result.passed,false); assert.match(result.summary,/provider changed/); }
 finally {globalThis.setTimeout=timer;}
 console.log('PASS: switching providers cannot bypass two-observation confirmation');
}
globalThis.fetch=nativeFetch;
