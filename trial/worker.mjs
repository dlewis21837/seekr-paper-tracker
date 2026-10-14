import { discover } from './solana-feed.mjs';
import { State, stateGet, statePut, getBestPair, getSolanaSafety, insidePacificWindow } from './scanner-base.mjs';
export { State };
const TRIAL_PAUSED = false; // Original scanner paused for this comparison.
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

// Simulation: sampled prices with 2% adverse fill on each side.
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
    if ((t.tookHalf && x <= t.peak * .65) || now - t.entryAt >= 86400000) {
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
  return JSON.parse(await stateGet(env, key) || JSON.stringify(fallback));
}


function escapeHtml(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function formatTrialAlert(t) {
  const link = 'https://dexscreener.com/solana/' + encodeURIComponent(t.contract);
  return ['🧪 <b>PUMPSWAP LOW-CAP — ' + escapeHtml(t.name) + '</b>',
    'Confirmed candidate • simulation trial',
    'Market cap: $' + Math.round(Number(t.entryCap)).toLocaleString('en-US'),
    'Safety: ' + escapeHtml(t.safety),
    'CA: <a href="' + link + '">' + escapeHtml(t.contract) + '</a>',
    'Simulated entry only; no purchase was made.'].join('\n');
}
async function deliverTrialAlerts(env, trades, result) {
  if (!insidePacificWindow()) return;
  const pending = trades.filter(t => t.alertState === 'pending' && !t.closedAt);
  if (!pending.length) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    result.errors.push({error:'Trial alerts require TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID'});
    return;
  }
  for (const t of pending) {
    try {
      const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method:'POST', signal:AbortSignal.timeout(15000),
        headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:formatTrialAlert(t),
          parse_mode:'HTML',disable_web_page_preview:true})
      });
      const receipt = await response.json();
      if (!response.ok || !receipt.ok) throw new Error('Telegram delivery failed: ' + (receipt.description || response.status));
      t.alertState = 'sent'; t.alertSentAt = Date.now(); delete t.alertError;
      await statePut(env,JSON.stringify(trades),'trial_trades');
      result.alertsSent.push(t.contract);
    } catch(e) {
      t.alertError = String(e);
      result.errors.push({contract:t.contract,error:String(e)});
      await statePut(env,JSON.stringify(trades),'trial_trades');
    }
  }
}

async function run(env) {
  if (TRIAL_PAUSED) {
    const result = { at: new Date().toISOString(), ok: true, paused: true,
      skipped: 'Temporarily paused to diagnose original scanner rate limits' };
    console.log('TRIAL_SCAN', JSON.stringify(result));
    return result;
  }
  console.log('TRIAL_SCAN_START', new Date().toISOString());
  const stub = env.STATE.get(env.STATE.idFromName('seekr'));
  const token = crypto.randomUUID();
  const lease = await stub.fetch('https://state/acquire', {
    method: 'POST', body: token
  }).then(r => r.json());
  if (!lease.acquired) {
    console.log('TRIAL_SCAN', 'Already running');
    return { skipped: 'Already running' };
  }
  const now = Date.now();
  env = {
    ...env,
    _scanDeadline: now + 140000,
    _dex: {
      cache: new Map(), confirmations: new Map(), sharedConfirmations: 0,
      requests: 0, cacheHits: 0, throttled: 0, priority: 'discovery'
    }
  };
  const result = {
    at: new Date(now).toISOString(), mode: 'SIMULATION', opened: [], alertsSent: [], errors: []
  };
  try {
    const trades = await jsonGet(env, 'trial_trades', []);
    for (const t of trades.filter(t => !t.closedAt)) {
      try {
        const p = await getBestPair(t.contract, 'pumpswap', 'solana', env);
        if (!p || p.pairAddress !== t.pairAddress || p.quoteToken?.address !== SOL) {
          throw new Error('Original SOL pool missing');
        }
        mark(t, Number(p.priceUsd), now);
        delete t.priceError;
      } catch (e) {
        t.priceError = String(e);
        result.errors.push({ contract: t.contract, error: String(e) });
      }
    }
    await statePut(env, JSON.stringify(trades), 'trial_trades');
    if (!insidePacificWindow()) {
      result.skipped = 'Outside 5am–8pm Pacific entry window';
    } else if (trades.length >= 100 || trades.filter(t => !t.closedAt).length >= 10) {
      result.skipped = 'Trial capacity reached';
    } else {
      const discovery = await discover(env);
      result.discovery = discovery.source;
      result.feedBudget = discovery.budget;
      result.skipped = discovery.skipped || null;
      const candidates = discovery.candidates.filter(
        contract => !trades.some(t => t.contract === contract)
      );
      result.discovered = candidates.length;
      for (const contract of [...new Set(candidates)].slice(0, 4)) {
        if (Date.now() + 35000 >= env._scanDeadline) break;
        try {
          const first = await getBestPair(contract, 'pumpswap', 'solana', env);
          if (!gate(first)) continue;
          const safety = await getSolanaSafety(contract, env);
          if (!safety.passed) {
            result.errors.push({ contract, error: safety.summary });
            continue;
          }
          const observations = await jsonGet(env, 'trial_observations', {});
          const prev = observations[contract];
          observations[contract] = {
            at: now, price: Number(first.priceUsd),
            liquidity: Number(first.liquidity.usd), pair: first.pairAddress
          };
          for (const k of Object.keys(observations)) {
            if (now - observations[k].at > 10 * 60000) delete observations[k];
          }
          await statePut(env, JSON.stringify(observations), 'trial_observations');
          if (!prev || now - prev.at < 120000 || now - prev.at > 10 * 60000 ||
              prev.pair !== first.pairAddress ||
              Number(first.priceUsd) < prev.price * .95 ||
              Number(first.liquidity.usd) < prev.liquidity * .9) continue;
          trades.push({
            contract, name: first.baseToken.name, pairAddress: first.pairAddress,
            entryAt: now, entryCap: first.marketCap,
            entryPrice: Number(first.priceUsd) * 1.02,
            remaining: 1, realized: 0, peak: 1,
            multiple: .98 / 1.02, safety: safety.summary, alertState: 'pending'
          });
          result.opened.push(contract);
          await statePut(env, JSON.stringify(trades), 'trial_trades');
          break;
        } catch (e) {
          result.errors.push({ contract, error: String(e) });
        }
      }
    }
    await deliverTrialAlerts(env, trades, result);
    result.ok = !result.errors.length;
  } catch (e) {
    result.ok = false;
    result.errors.push({ error: String(e) });
  } finally {
    result.completedAt = new Date().toISOString();
    console.log('TRIAL_SCAN', JSON.stringify(result));
    try {
      await statePut(env, JSON.stringify(result), 'trial_status');
    } finally {
      await stub.fetch('https://state/release', { method: 'POST', body: token });
    }
  }
  return result;
}

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/health") {
      const last = await jsonGet(env, "trial_status", {});
      return Response.json({ build: "low-cap-provider-gateway-2026-10-14", paused: TRIAL_PAUSED,
        configured: Boolean(env.STATE && env.SOLANATRACKER_API_KEY && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        manualAccessConfigured: Boolean(env.RUN_KEY),
        missingSettings: ["RUN_KEY", "STATE", "SOLANATRACKER_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter(key => !env[key]),
        lastScanAt: last.at || null, lastCompletedAt: last.completedAt || null,
        ok: last.ok ?? null, skipped: last.skipped || null, errorCount: last.errors?.length || 0,
        errorSummary: [...new Set((last.errors || []).map(item => String(item.error || "").replace(/https?:\/\/\S+/g, "[provider URL]").slice(0, 250)))].slice(0, 4),
        discovered: last.discovered ?? null, alertsSent: last.alertsSent?.length || 0 });
    }
    if (!env.RUN_KEY || req.headers.get('Authorization') !== `Bearer ${env.RUN_KEY}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    const path = new URL(req.url).pathname;
    if (path === '/run' && req.method === 'POST') {
      return Response.json(await run(env));
    }
    if (path === '/status') {
      return Response.json({
        ...await jsonGet(env, 'trial_status', {}),
        paused: TRIAL_PAUSED,
        feedBudget: await jsonGet(env, 'free_feed_budget', {})
      });
    }
    if (path === '/results') {
      return Response.json({
        mode: 'SIMULATION', trades: await jsonGet(env, 'trial_trades', [])
      });
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  }
};
// END OF COMPLETE FILE
