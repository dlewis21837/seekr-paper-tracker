import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTrade,evaluateStream,inAlertWindow,PumpPortalFeed} from './pumpportal-experiment.mjs';
const mint='So11111111111111111111111111111111111111112';
const wallet='FoGucx88W22tvWygW1BGxJgWg961UuD8Mtgw9Rmnpump';
const event={mint,traderPublicKey:wallet,signature:'sig',txType:'buy',solAmount:1,tokenAmount:100};
function envContext(env={}){
  const values=new Map();const ctx={storage:{async get(k){return values.get(k)},async put(k,v){values.set(k,v)},async setAlarm(){}},waitUntil(){}};
  return {feed:new PumpPortalFeed(ctx,env),values};
}
test('normalizes SOL units and prices without calling an exchange or trading',()=>{
  const r=normalizeTrade(event,1000);assert.equal(r.attributes.volume_in_usd,1);
  assert.equal(r.attributes.price_to_in_usd,.01);
  assert.equal(normalizeTrade({...event,tokenAmount:0},1000),null);
  assert.equal(normalizeTrade({...event,mint:'bad'},1000),null);
});
test('Pacific observation window handles daylight saving',()=>{
  assert.equal(inAlertWindow(Date.parse('2026-10-20T12:00:00Z')),true);
  assert.equal(inAlertWindow(Date.parse('2026-10-21T03:00:00Z')),false);
  assert.equal(inAlertWindow(Date.parse('2026-12-20T12:00:00Z')),false);
  assert.equal(inAlertWindow(Date.parse('2026-12-20T13:00:00Z')),true);
});
test('metered trade subscriptions default off even with an API key',async()=>{
  const {feed}=envContext({PUMPPORTAL_API_KEY:'secret'});let sent=0;feed.ws={send(){sent++}};
  await feed.nominate({...event,txType:'create'});
  assert.equal(feed.tradeLimit(),0);assert.equal(sent,0);assert.equal(feed.tokens.size,1);
});
test('invalid budgets cannot enable metered subscriptions',()=>{
  for(const n of ['-1','NaN','1.5'])assert.equal(envContext({DAILY_TRADE_EVENT_LIMIT:n}).feed.tradeLimit(),0);
  assert.equal(envContext({DAILY_TRADE_EVENT_LIMIT:'100000'}).feed.tradeLimit(),10000);
});
test('funded-data budget is persisted across listener restarts',async()=>{
  const {feed,values}=envContext();values.set('budget',{day:new Date().toISOString().slice(0,10),events:9000});
  assert.equal((await feed.budget()).events,9000);
});
test('complete streaming windows use SOL trigger thresholds, not USD',()=>{
  const now=Date.now();let id=0;
  const trade=(seconds,w,sol,price)=>normalizeTrade({...event,signature:String(++id),traderPublicKey:w,
    solAmount:sol,tokenAmount:sol/price},now-seconds*1000);
  // Generate distinct valid Solana-shaped addresses for the fixture.
  const wallets=Array.from({length:14},(_,i)=>'1'.repeat(31)+'23456789ABCDEFGH'[i]);
  const rows=[...Array.from({length:4},(_,i)=>trade(110-i*10,wallets[i],.5,1)),
    ...Array.from({length:10},(_,i)=>trade(55-i*5,wallets[i+4],.7,1+i*.002))];
  const r=evaluateStream(rows,mint,now);assert.equal(r.passed,true);assert.equal(r.units,'SOL');
  assert.ok(r.netBuySOL>=6.9);assert.equal(r.timestampBasis,'local receipt time');
});
test('observation storage deduplicates without Telegram enabled',async()=>{
  const {feed,values}=envContext();
  const token={mint,name:'Test'},r={passed:true,buySOL:5,sellSOL:1,netBuySOL:4};
  await feed.observe(token,r);await feed.observe(token,r);
  assert.equal(values.get('observations').length,1);
  assert.match(values.get('observations')[0].safety,/NOT EVALUATED/);
});
