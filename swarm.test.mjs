import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSwarm } from './swarm.mjs';
const now = Date.parse('2026-10-21T01:00:00Z'), token = 'candidate';
function fixture() {
  let id = 0;
  const trade = (seconds, wallet, usd, price=1, buy=true) => ({ id: String(++id), attributes: {
    block_timestamp: new Date(now-seconds*1000).toISOString(), tx_from_address: wallet,
    tx_hash: 'tx'+id, kind: buy?'buy':'sell', volume_in_usd: String(usd),
    from_token_address: buy?'SOL':token, to_token_address: buy?token:'SOL',
    price_from_in_usd: String(buy?100:price), price_to_in_usd: String(buy?price:100) } });
  return { data: [ ...Array.from({length:4},(_,i)=>trade(110-i*10,'old'+i,100)),
    ...Array.from({length:10},(_,i)=>trade(55-i*5,'new'+i,100,1+i*.002)),
    trade(3,'seller',100,1.018,false) ] };
}
test('accelerating distinct buyers and dollars pass without score, age or cap',()=>{
  const r=detectSwarm(fixture(),token,now); assert.equal(r.passed,true);
  assert.equal(r.buyers,10); assert.equal(r.previousBuyers,4); assert.equal(r.netBuyUsd,900);
  assert.equal(r.walletIndependenceVerified,false); assert.equal('score' in r,false);
});
test('repeated transactions from one buyer are not a swarm',()=>{
  const p=fixture(); for(const t of p.data.slice(4,14))t.attributes.tx_from_address='one';
  assert.equal(detectSwarm(p,token,now).passed,false);
});
test('one whale dominating dollars fails despite many buyers',()=>{
  const p=fixture();p.data[4].attributes.volume_in_usd='10000';
  assert.match(detectSwarm(p,token,now).summary,/concentrated/);
});
test('high sell dollars block even when buy count is high',()=>{
  const p=fixture();p.data.at(-1).attributes.volume_in_usd='2000';
  assert.equal(detectSwarm(p,token,now).passed,false);
});
test('steady activity without acceleration fails',()=>{
  const p=fixture(); for(let i=0;i<10;i++)p.data.push({id:'prior'+i,attributes:{...p.data[i%4].attributes,tx_from_address:'p'+i}});
  assert.equal(detectSwarm(p,token,now).passed,false);
});
test('stale, incomplete, wrong-token, future and anomalous trades fail closed',()=>{
  assert.equal(detectSwarm(fixture(),token,now+60_000).passed,false);
  for(const [field,value] of [['tx_from_address',''],['volume_in_usd','bad'],['to_token_address','other'],
    ['block_timestamp',new Date(now+60_000).toISOString()],['is_anomalous',true]]) {
    const p=fixture();p.data[4].attributes[field]=value;
    assert.equal(detectSwarm(p,token,now).passed,false,field);
  }
});
test('duplicate rows cannot inflate demand',()=>{
  const p=fixture(), before=detectSwarm(p,token,now);p.data.push(...p.data);
  assert.equal(detectSwarm(p,token,now).buyUsd,before.buyUsd);
});
test('a truncated 300-trade window blocks rather than comparing partial minutes',()=>{
  const p=fixture();p.data=Array.from({length:300},(_,i)=>({id:'x'+i,attributes:{...p.data[4].attributes}}));
  assert.match(detectSwarm(p,token,now).summary,/truncated/);
});
test('price must respond to the buying',()=>{
  const p=fixture();for(const t of p.data){t.attributes.price_to_in_usd='1';t.attributes.price_from_in_usd='1';}
  assert.match(detectSwarm(p,token,now).summary,/price not responding/);
});
