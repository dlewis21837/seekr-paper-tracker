import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, {gate,mark,SOL} from './worker.mjs';
const now=Date.now();
const p={chainId:'solana',dexId:'pumpswap',quoteToken:{address:SOL},marketCap:50000,liquidity:{usd:20000},priceUsd:.001,txns:{m5:{buys:30,sells:10}},volume:{m5:5000},priceChange:{m5:10},pairCreatedAt:now-3600000};
test('Reject other exchanges, fake quotes, unknown cap, chase and missing data',()=>{
 assert.ok(gate(p,now));
 for (const v of [{dexId:'meteora'},{quoteToken:{address:'fake'}},{marketCap:undefined},{marketCap:19999},{marketCap:75001},{priceChange:{m5:50}},{txns:{}},{liquidity:{usd:9999}}]) assert.equal(gate({...p,...v},now),false);
});
const trade=()=>({entryPrice:1,entryAt:now,peak:1,remaining:1,realized:0});
test('Gap through stop uses observed adverse fill rather than promised stop price',()=>{
 const t=mark(trade(),.4,now+1);assert.equal(t.remaining,0);assert.equal(t.multiple,.392);
});
test('Half at 2x and remaining half trails from peak',()=>{
 const t=mark(trade(),2.1,now+1);assert.equal(t.remaining,.5);
 mark(t,3,now+2);mark(t,1.8,now+3);assert.equal(t.remaining,0);assert.ok(Math.abs(t.multiple-1.911)<1e-9);
});
test('Unknown price does not turn a missing pool into a profit or close',()=>{const t=trade();assert.deepEqual(mark(t,NaN,now),trade());});
test('Trial expires position using sampled price',()=>{assert.equal(mark(trade(),1,now+86400000).closedAt,now+86400000);});
test('Status and runs require separate secret',async()=>{
 assert.equal((await worker.fetch(new Request('https://test/run',{method:'POST'}),{})).status,401);
});

import {allowance,extractCandidates} from './solana-feed.mjs';
test('Feed ends after seven days and blocks requests above budget or before cooldown',()=>{
 assert.equal(allowance({},now),null);
 assert.ok(allowance({startedAt:now-7*86400000},now));
 assert.ok(allowance({requests:2200},now));
 assert.ok(allowance({nextAt:now+1},now));
 assert.equal(allowance({requests:2199,nextAt:now},now),null);
});
test('Feed uses documented mint field and rejects other pools or unknown schema',()=>{
 const t={mint:SOL,market:'pumpfun-amm',quoteToken:SOL,marketCapUsd:50000,liquidityUsd:20000};
 assert.deepEqual(extractCandidates({status:'success',data:[t,t,{...t,market:'meteora'}]}),[SOL]);
 assert.throws(()=>extractCandidates({data:[]}));
});
