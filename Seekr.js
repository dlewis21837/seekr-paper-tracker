const CHANNEL = "SeekrTrending";
const MAX_MARKET_CAP = 3_000_000;
const MIN_LIQUIDITY = 10_000;
const MIN_SCORE = 4;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await scan(env);
      return Response.json(result);
    }
    return Response.json({
      status: "Seekr tracker online",
      schedule: "Every 3 minutes, 5:00 a.m.–8:00 p.m. Pacific",
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.STATE),
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scan(env));
  },
};

export class State {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/get") {
      return new Response(String((await this.storage.get("last_message_id")) || 0));
    }
    if (url.pathname === "/put" && request.method === "POST") {
      await this.storage.put("last_message_id", await request.text());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }
}

async function stateGet(env) {
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  return Number(await stub.fetch("https://state/get").then((r) => r.text())) || 0;
}

async function statePut(env, value) {
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  await stub.fetch("https://state/put", { method: "POST", body: String(value) });
}

async function scan(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.STATE) {
    return { ok: false, error: "Missing Telegram secrets or STATE binding" };
  }
  if (!insidePacificWindow()) return { ok: true, skipped: "Outside active hours" };

  const html = await fetch(`https://t.me/s/${CHANNEL}`, {
    headers: { "User-Agent": "Mozilla/5.0 SeekrTracker/1.0" },
  }).then(check).then((r) => r.text());

  const calls = parseCalls(html);
  let lastId = await stateGet(env);
  const newestId = calls.reduce((n, c) => Math.max(n, c.id), lastId);

  // First run establishes a baseline so old calls do not flood Telegram.
  if (!lastId) {
    await statePut(env, newestId);
    await sendTelegram(env, "✅ Seekr tracker connected. Scanning every 3 minutes from 5:00 a.m. to 8:00 p.m. Pacific.");
    return { ok: true, baseline: newestId };
  }

  const fresh = calls.filter((c) => c.id > lastId).sort((a, b) => a.id - b.id);
  const results = [];
  for (const call of fresh) {
    try {
      const pair = await getBestPair(call.contract);
      const review = scorePair(call, pair);
      if (review.score >= MIN_SCORE && review.marketCap <= MAX_MARKET_CAP) {
        await sendTelegram(env, formatAlert(call, pair, review));
        results.push({ contract: call.contract, alerted: true, score: review.score });
      } else {
        results.push({ contract: call.contract, alerted: false, score: review.score });
      }
    } catch (error) {
      results.push({ contract: call.contract, error: String(error) });
    }
  }

  if (newestId > lastId) await statePut(env, newestId);
  return { ok: true, checked: fresh.length, results };
}

function insidePacificWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return hour >= 5 && hour < 20;
}

function parseCalls(html) {
  const starts = [...html.matchAll(/data-post="SeekrTrending\/(\d+)"/g)];
  const calls = [];
  for (let i = 0; i < starts.length; i++) {
    const id = Number(starts[i][1]);
    const block = html.slice(starts[i].index, starts[i + 1]?.index ?? html.length);
    const text = decodeHtml(block.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n");
    if (!/is now on\s+Seekr Trending/i.test(text)) continue;
    const contract = text.match(/(?:CA\s*:\s*)?\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/)?.[1];
    if (!contract) continue;
    const name = text.match(/([^\n]{1,80}?)\s+is now on\s+Seekr Trending/i)?.[1]?.trim() || "Unknown";
    const calledMarketCap = money(text.match(/Market Cap\s*:\s*\$?([0-9.,]+\s*[KMB]?)/i)?.[1]);
    const paid = /Dexscreener Paid\s*:[^\n]*(?:✅|yes)/i.test(text);
    calls.push({ id, name, contract, calledMarketCap, paid });
  }
  return calls;
}

async function getBestPair(contract) {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
  const data = await check(response).then((r) => r.json());
  const pairs = (data.pairs || []).filter((p) => p.chainId === "solana");
  return pairs.sort((a, b) => num(b.liquidity?.usd) - num(a.liquidity?.usd))[0] || null;
}

function scorePair(call, pair) {
  if (!pair) return { score: 0, marketCap: Infinity, reasons: ["No Solana pool"] };
  const marketCap = num(pair.marketCap || pair.fdv);
  const liquidity = num(pair.liquidity?.usd);
  const volumeH1 = num(pair.volume?.h1);
  const changeH1 = num(pair.priceChange?.h1);
  const buys = num(pair.txns?.h1?.buys);
  const sells = num(pair.txns?.h1?.sells);
  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 99999;
  let score = 0;
  const reasons = [];
  if (marketCap >= 20_000 && marketCap <= 1_500_000) { score += 2; reasons.push("early market cap"); }
  else if (marketCap <= MAX_MARKET_CAP) { score += 1; reasons.push("market cap still has room"); }
  if (liquidity >= 25_000) { score += 2; reasons.push("solid liquidity"); }
  else if (liquidity >= MIN_LIQUIDITY) { score += 1; reasons.push("acceptable liquidity"); }
  if (volumeH1 >= 20_000) { score += 2; reasons.push("strong 1h volume"); }
  else if (volumeH1 >= 7_500) { score += 1; reasons.push("building 1h volume"); }
  if (buys >= 20 && buys > sells * 1.15) { score += 1; reasons.push("buy pressure"); }
  if (changeH1 >= 5 && changeH1 <= 250) { score += 1; reasons.push("positive momentum"); }
  if (ageMinutes <= 180) { score += 1; reasons.push("very young pool"); }
  if (liquidity < MIN_LIQUIDITY) { score -= 3; reasons.push("thin liquidity"); }
  if (call.paid) { score -= 1; reasons.push("DexScreener promotion flagged"); }
  return { score, marketCap, liquidity, volumeH1, changeH1, buys, sells, ageMinutes, reasons };
}

function formatAlert(call, pair, r) {
  const link = pair?.url || `https://dexscreener.com/solana/${call.contract}`;
  return [
    `🚨 <b>SEEKR CANDIDATE — ${esc(call.name)}</b>`,
    `Score: <b>${r.score}/9</b>`,
    `Market cap: <b>${usd(r.marketCap)}</b>`,
    `Liquidity: ${usd(r.liquidity)}`,
    `1h volume: ${usd(r.volumeH1)}`,
    `1h change: ${r.changeH1.toFixed(1)}%`,
    `1h buys/sells: ${r.buys}/${r.sells}`,
    `Why: ${esc(r.reasons.join(", "))}`,
    `CA: <a href="${link}">${call.contract}</a>`,
    "⚠️ Preliminary alert only—verify holders, insiders, bundlers and socials before risking money.",
  ].join("\n");
}

async function sendTelegram(env, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  await check(response);
}

function money(value) {
  if (!value) return null;
  const clean = value.replace(/,/g, "").trim().toUpperCase();
  const n = parseFloat(clean);
  const multiplier = clean.endsWith("K") ? 1e3 : clean.endsWith("M") ? 1e6 : clean.endsWith("B") ? 1e9 : 1;
  return Number.isFinite(n) ? n * multiplier : null;
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function usd(value) { return Number.isFinite(value) ? `$${Math.round(value).toLocaleString("en-US")}` : "n/a"; }
function esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function check(response) { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response; }
