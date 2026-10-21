import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
const url = new URL('./worker.testable.mjs',import.meta.url);
await writeFile(url,(await readFile(new URL('./worker.js',import.meta.url),'utf8'))+
  '\nexport {sendSwarmAlert,formatAlert,reviewMarket,passesMarketSafety,selectBestPair,getTradeSwarm};');
const f=await import(url.href); await unlink(url);
const mint='So11111111111111111111111111111111111111112';
const pair={chainId:'solana',dexId:'pumpswap',pairAddress:'Pool',baseToken:{address:'token'},
  quoteToken:{address:mint},priceUsd:'1',marketCap:100000000,liquidity:{usd:10000000},
  txns:{h1:{buys:40,sells:20}},priceChange:{m5:1,h1:500},volume:{h1:1000}};
function environment(){
  const values=new Map();
  const env={TELEGRAM_BOT_TOKEN:'test',TELEGRAM_CHAT_ID:'test',STATE:{idFromName:x=>x,get:()=>({
    async fetch(url,options={}){
      const u=new URL(url),key=u.searchParams.get('key');
      if(u.pathname==='/get')return new Response(values.get(key)||'');
      if(u.pathname==='/put'){values.set(key,options.body);return new Response('ok');}
      if(u.pathname==='/provider-fetch')return new Response('limited',{status:429});
      throw Error('Unexpected request '+url);
    }})}};
  return {env,values};
}
test('age and market-cap context cannot impose a score or a cap veto',()=>{
  const r=f.reviewMarket({},pair);assert.equal('score' in r,false);
  assert.equal(f.passesMarketSafety(r),true);
});
test('SOL quote and exact candidate contract are mandatory',()=>{
  assert.equal(f.selectBestPair([pair],'token'),pair);
  assert.equal(f.selectBestPair([{...pair,quoteToken:{address:'USDC'}}],'token'),null);
  assert.equal(f.selectBestPair([pair],'TOKEN'),null);
});
test('delivery requires safety and a fresh passing swarm, then suppresses repeat tokens',async()=>{
  const {env}=environment();let sends=0;const original=globalThis.fetch;
  globalThis.fetch=async()=>{sends++;return Response.json({ok:true});};
  try{
    const review={...f.reviewMarket({},pair),safety:{passed:true,summary:'passed'},
      confirmation:{swarm:{passed:true,observedAt:Date.now(),previousBuyers:4,buyers:10,newBuyers:8,
        buyUsd:1000,sellUsd:100,netBuyUsd:900,buyerAcceleration:2.5,dollarAcceleration:2.5}}};
    assert.equal(await f.sendSwarmAlert(env,{contract:'token',name:'Token'},pair,{...review,safety:{passed:false}}),false);
    assert.equal(await f.sendSwarmAlert(env,{contract:'token',name:'Token'},pair,review),true);
    assert.equal(await f.sendSwarmAlert(env,{contract:'token',name:'Token',source:'PUMPSWAP'},pair,review),false);
    assert.equal(sends,1);
    assert.doesNotMatch(f.formatAlert({contract:'token',name:'Token'},pair,review),/Score:|\/9/);
    assert.match(f.formatAlert({contract:'token',name:'Token'},pair,review),/CA: <a href=/);
  }finally{globalThis.fetch=original;}
});
test('trade provider rate limits are visible and block the trigger',async()=>{
  const {env,values}=environment();
  const r=await f.getTradeSwarm('token',pair,env);
  assert.equal(r.passed,false);assert.match(r.summary,/unavailable/);
  assert.equal(env._swarm.unavailable,1);assert.ok(values.get('gecko_provider_retry_at'));
});
