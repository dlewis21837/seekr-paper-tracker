import { detectSwarm, SWARM } from './swarm.mjs';

const BUILD = 'pumpportal-observation-v1';
const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const rules = { ...SWARM, minBuyUsd: 5, minNetBuyUsd: 2 };
export function normalizeTrade(event, receivedAt) {
  if (!mintPattern.test(event?.mint || '') || !['buy','sell'].includes(event?.txType)) return null;
  const amount = Number(event.tokenAmount), sol = Number(event.solAmount);
  if (!event.signature || !mintPattern.test(event.traderPublicKey || '') ||
      !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(sol) || sol <= 0) return null;
  const buy = event.txType === 'buy';
  return { id: `${event.signature}:${event.mint}:${event.txType}`, attributes: {
    block_timestamp: new Date(receivedAt).toISOString(), tx_hash: event.signature,
    tx_from_address: event.traderPublicKey, kind: event.txType,
    from_token_address: buy ? 'SOL' : event.mint,
    to_token_address: buy ? event.mint : 'SOL',
    volume_in_usd: sol, price_from_in_usd: buy ? 1 : sol/amount,
    price_to_in_usd: buy ? sol/amount : 1,
  } };
}
export function evaluateStream(rows, mint, now) {
  // The shared detector is unit-agnostic; use SOL throughout this experiment.
  const r = detectSwarm({ data: rows, meta: { completeWindow: true } }, mint, now, rules);
  return { ...r, units: 'SOL', timestampBasis: 'local receipt time',
    buySOL: r.buyUsd, sellSOL: r.sellUsd, netBuySOL: r.netBuyUsd };
}
export function inAlertWindow(now = Date.now()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone:'America/Los_Angeles', hour:'numeric', hourCycle:'h23' }).format(now));
  return hour >= 5 && hour < 20;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!['/','/status'].includes(path)) return new Response('Not found',{status:404});
    if (!env.FEED) return Response.json({build:BUILD,error:'FEED binding missing'},{status:503});
    return env.FEED.get(env.FEED.idFromName('experiment')).fetch('https://feed/status');
  },
  async scheduled(controller, env, ctx) {
    // The cron is only a recovery heartbeat; trades arrive over one WebSocket.
    ctx.waitUntil(env.FEED.get(env.FEED.idFromName('experiment')).fetch('https://feed/tick'));
  }
};

export class PumpPortalFeed {
  constructor(ctx, env) {
    this.ctx=ctx; this.env=env; this.ws=null; this.connecting=null;
    this.queue=Promise.resolve(); this.tokens=new Map(); this.subscriptions=new Set();
    this.stats={build:BUILD,connected:false,creations:0,migrations:0,tradeEvents:0,
      invalidTrades:0,droppedTokens:0,observations:0,lastEventAt:null,lastError:null};
    this.connectionStartedAt=0; this.lastCheckpoint=0;
  }
  async fetch(request) {
    if(new URL(request.url).pathname==='/tick') { await this.tick(); return new Response('ok'); }
    return Response.json({ ...this.stats, experimentOnly:true, tradingEnabled:false,
      feedMode:this.tradeLimit()>0 && this.env.PUMPPORTAL_API_KEY?'metered-trades':'free-discovery',
      configuredForTrades:Boolean(this.env.PUMPPORTAL_API_KEY) && this.tradeLimit()>0,
      tradeEventLimit:this.tradeLimit(), activeSubscriptions:this.subscriptions.size,
      pendingObservations:this.tokens.size,
      recentDiscoveries:[...this.tokens.values()].slice(-20).map(t=>({mint:t.mint,name:t.name,discoveredAt:new Date(t.createdAt).toISOString()})), currentSessionStartedAt:this.connectionStartedAt || null,
      saved:await this.ctx.storage.get('checkpoint') || null,
      observations:await this.ctx.storage.get('observations') || [],
      budget:await this.ctx.storage.get('budget') || null,
      limitations:['Bounded discovery and token subscriptions; not whole-chain coverage',
        'Local receipt timestamps; not measured blockchain-to-alert latency',
        'Experimental swarm observations are NOT safety-cleared trade recommendations',
        'Distinct addresses do not establish independent wallet control'] });
  }
  tradeLimit() {
    const n=Number(this.env.DAILY_TRADE_EVENT_LIMIT || 0);
    return Number.isSafeInteger(n) && n>0 ? Math.min(n,10000) : 0;
  }
  async budget() {
    const day=new Date().toISOString().slice(0,10);
    const b=await this.ctx.storage.get('budget');
    // UTC provider-message budget, not a guaranteed provider billing limit.
    return b?.day===day ? b : {day,events:0};
  }
  async tick() {
    await this.ctx.storage.setAlarm(Date.now()+60_000);
    if(this.env.EXPERIMENT_ENABLED!=='true') {
      this.disconnect(); this.stats.lastError='Disabled; set EXPERIMENT_ENABLED=true to start';
      await this.checkpoint(); return;
    }
    if(!inAlertWindow()) { this.disconnect(true); await this.checkpoint(); return; }
    const b=await this.budget();
    if(this.tradeLimit()>0 && b.events>=this.tradeLimit()) {
      this.disconnect(); this.stats.lastError='Trade-event budget reached; paused until next UTC day';
      await this.checkpoint(); return;
    }
    if(!this.ws) await this.connect();
    await this.prune(); await this.checkpoint();
  }
  async alarm() { await this.tick(); }
  disconnect(clearTokens = false) {
    const ws=this.ws; this.ws=null; this.stats.connected=false;
    this.subscriptions.clear();
    if(clearTokens)this.tokens.clear();
    if(ws) { try { ws.close(1000,'Experiment pause/reconnect'); } catch {} }
  }
  async connect() {
    if(this.connecting)return this.connecting;
    this.connecting=this.open().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async open() {
    try {
      const url=new URL('https://pumpportal.fun/api/data');
      if(this.env.PUMPPORTAL_API_KEY)url.searchParams.set('api-key',this.env.PUMPPORTAL_API_KEY);
      const response=await fetch(url,{headers:{Upgrade:'websocket'},signal:AbortSignal.timeout(15_000)});
      const ws=response.webSocket;
      if(!ws)throw Error('WebSocket upgrade failed ('+response.status+')');
      ws.accept(); this.ws=ws; this.connectionStartedAt=Date.now();
      this.stats.connected=true;this.stats.lastError=null;
      ws.addEventListener('message',e=>{
        this.queue=this.queue.then(()=>this.message(e.data,ws)).catch(async()=>{
          this.stats.lastError='Message processing failed'; await this.checkpoint();
        });
        this.ctx.waitUntil(this.queue);
      });
      const closed=()=>{if(this.ws===ws){this.ws=null;this.stats.connected=false;
        this.subscriptions.clear();}};
      ws.addEventListener('close',closed);ws.addEventListener('error',closed);
      ws.send(JSON.stringify({method:'subscribeNewToken'}));
      ws.send(JSON.stringify({method:'subscribeMigration'}));
      await this.prune();
      if(this.env.PUMPPORTAL_API_KEY && this.tradeLimit()>0) {
        const b=await this.budget();
        if(b.events<this.tradeLimit()) for(const t of this.tokens.values()) {
          t.rows=[];t.seen=new Set();t.gap=false;t.subscribedAt=Date.now();
          ws.send(JSON.stringify({method:'subscribeTokenTrade',keys:[t.mint]}));
          this.subscriptions.add(t.mint);
        }
      }
    } catch {
      // Do not log the connection URL or provider error text: both may contain an API key.
      this.stats.lastError='PumpPortal connection failed; retry on next heartbeat';
      this.disconnect();
    }
  }
  async nominate(e) {
    if(!mintPattern.test(e.mint || '') || this.tokens.has(e.mint))return;
    if(this.tokens.size>=50){this.stats.droppedTokens++;return;}
    const token={mint:e.mint,name:String(e.name || e.symbol || e.mint).slice(0,80),
      createdAt:Date.now(),subscribedAt:Date.now(),rows:[],seen:new Set(),gap:false};
    this.tokens.set(e.mint,token);
    if(!this.env.PUMPPORTAL_API_KEY || !this.tradeLimit())return;
    const b=await this.budget();if(b.events>=this.tradeLimit())return;
    this.ws.send(JSON.stringify({method:'subscribeTokenTrade',keys:[e.mint]}));
    this.subscriptions.add(e.mint);
  }
  async prune() {
    const expired=[...this.tokens.values()].filter(t=>Date.now()-t.createdAt>15*60_000);
    const keys=expired.filter(t=>this.subscriptions.has(t.mint)).map(t=>t.mint);
    if(keys.length && this.ws)this.ws.send(JSON.stringify({method:'unsubscribeTokenTrade',keys}));
    for(const t of expired){this.tokens.delete(t.mint);this.subscriptions.delete(t.mint);}
  }
  async message(raw, ws) {
    if(this.ws!==ws)return;
    if(this.env.EXPERIMENT_ENABLED!=='true' || !inAlertWindow()){this.disconnect();return;}
    let e;try{e=JSON.parse(raw);}catch{return;}
    this.stats.lastEventAt=new Date().toISOString();
    if(e.errors || e.error) {this.stats.lastError='Provider reported an error; inspect credentials/funding';return;}
    if(e.txType==='create'){this.stats.creations++;await this.nominate(e);}
    else if(e.txType==='migration' || e.txType==='migrate'){this.stats.migrations++;await this.nominate(e);}
    else if(['buy','sell'].includes(e.txType)) {
      // Count every received trade before parsing/deduplicating; duplicates may also be billed.
      const b=await this.budget();b.events++;await this.ctx.storage.put('budget',b);
      this.stats.tradeEvents++;
      if(!this.tradeLimit() || b.events>=this.tradeLimit()){this.disconnect();return;}
      const t=this.tokens.get(e.mint);if(!t)return;
      const now=Date.now(),row=normalizeTrade(e,now);
      if(!row){this.stats.invalidTrades++;t.gap=true;return;}
      if(t.seen.has(row.id))return;
      t.rows=t.rows.filter(r=>Date.parse(r.attributes.block_timestamp)>now-120_000);
      t.seen=new Set(t.rows.map(r=>r.id));t.rows.push(row);t.seen.add(row.id);
      if(t.rows.length>2000){t.rows.shift();t.gap=true;}
      // Warm up for two full minutes after subscribe/reconnect; no zero-baseline false starts.
      if(t.gap || now-t.subscribedAt<120_000)return;
      const r=evaluateStream(t.rows,t.mint,now);
      if(r.passed)await this.observe(t,r);
    }
    if(Date.now()-this.lastCheckpoint>15_000)await this.checkpoint();
  }
  async observe(t,r) {
    const key='observed_'+t.mint;
    if(await this.ctx.storage.get(key))return;
    const at=new Date().toISOString();
    const item={mint:t.mint,name:t.name,at,trigger:r,safety:'NOT EVALUATED — observation only'};
    const observations=await this.ctx.storage.get('observations') || [];
    observations.push(item);await this.ctx.storage.put('observations',observations.slice(-100));
    await this.ctx.storage.put(key,at);this.stats.observations++;
    // Telegram is independently opt-in; no trading calls exist in this worker.
    if(this.env.EXPERIMENT_TELEGRAM_ENABLED!=='true' || !this.env.TELEGRAM_BOT_TOKEN || !this.env.TELEGRAM_CHAT_ID)return;
    const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const text=`🔬 <b>EXPERIMENT — SWARM OBSERVATION</b>\n${escape(t.name)}\n`+
      `Distinct buyers/minute: ${r.previousBuyers} → ${r.buyers}\n`+
      `Buy ${r.buySOL.toFixed(2)} SOL / sell ${r.sellSOL.toFixed(2)} SOL\n`+
      `Net buying: ${r.netBuySOL.toFixed(2)} SOL\n`+
      `CA: <a href="https://dexscreener.com/solana/${t.mint}">${t.mint}</a>\n`+
      `Observation only. Safety NOT evaluated. No trade recommendation.`;
    try {
      const response=await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
        method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10_000),
        body:JSON.stringify({chat_id:this.env.TELEGRAM_CHAT_ID,text,parse_mode:'HTML',disable_web_page_preview:true})});
      const receipt=await response.json();
      if(!response.ok || receipt.ok!==true)this.stats.lastError='Telegram observation delivery failed; observation retained';
    }catch{this.stats.lastError='Telegram observation delivery failed; observation retained';}
  }
  async checkpoint() {
    this.lastCheckpoint=Date.now();
    await this.ctx.storage.put('checkpoint',{...this.stats,at:new Date().toISOString(),
      activeSubscriptions:this.subscriptions.size,trackedTokens:this.tokens.size});
  }
}
