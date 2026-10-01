const CHANNEL = "SeekrTrending";
const BUILD_ID = "scanner-v32-temporary-health-updates-2026-10-01";
const HEALTH_UPDATE_CRONS = ["49,59 18 1 10 *", "9,19,29,39 19 1 10 *"];
const HEALTH_UPDATE_START = Date.parse("2026-10-01T18:49:00Z");
const HEALTH_UPDATE_END = Date.parse("2026-10-01T19:39:00Z");
const MAX_MARKET_CAP = 3_000_000;
const MAX_PUMPSWAP_MARKET_CAP = 2_000_000;
const MIN_LIQUIDITY = 10_000;
const MIN_SCORE = 1;
const FINAL_CONFIRM_DELAY_MS = 20_000;
const MAX_5M_DROP_PCT = -15;
const MAX_1H_DROP_PCT = -30;
const MIN_BUY_SELL_RATIO = 0.8;
const MIN_LIQUIDITY_TO_MARKET_CAP = 0.05;
const MAX_ACTIVE_POOL_PRICE_SPREAD = 1.5;
const MIN_POOL_INTEGRITY_LIQUIDITY = 1_000;
const MIN_POOL_INTEGRITY_TRADES_H1 = 10;
const MAX_CONFIRM_PRICE_DROP_PCT = 12;
const MAX_CONFIRM_LIQUIDITY_DROP_PCT = 20;
const ROBINHOOD_MIN_SCORE = 4;
const BNB_MIN_SCORE = 4;
const MAX_SINGLE_HOLDER_PCT = 15;
const MAX_TOP_10_HOLDERS_PCT = 45;
const MAX_INSIDER_HOLDINGS_PCT = 20;
const MAX_TRANSFER_FEE_PCT = 5;
const MAX_RUGCHECK_SCORE = 49;
const MIN_LP_LOCKED_PCT = 80;
const MIN_LP_LOCKED_USD = 10_000;
const MIN_MATERIAL_UNLOCKED_POOL_USD = 2_000;
const MIN_MATERIAL_UNLOCKED_POOL_RATIO = 0.02;
const MAX_CREATOR_HOLDINGS_PCT = 5;
const MAX_SUSPICIOUS_HOLDERS = 0;
const PUMPSWAP_MIN_H1_VOLUME = 5_000;
const PUMPSWAP_MIN_H1_BUYS = 20;
const PUMPSWAP_MIN_H1_BUYERS = 15;
const PUMPSWAP_MIN_BUY_SELL_RATIO = 1.1;
const PUMPSWAP_MIN_MOMENTUM_PCT = 8;
const PUMPSWAP_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const LEARNING_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const LEARNING_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEARNING_RECORD_LIMIT = 100;
const PAPER_ENTRY_MIN_MARKET_CAP = 150_000;
const PAPER_ENTRY_MAX_MARKET_CAP = 180_000;
const PAPER_STOP_MULTIPLE = 0.40;
const PAPER_STRATEGY_VERSION = "half-at-2x-trail-35-v1";
const PAPER_TAKE_PROFIT_MULTIPLE = 2;
const PAPER_TRAIL_FRACTION = 0.35;
const PAPER_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAPER_POSITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PAPER_RECORD_LIMIT = 300;

const BITQUERY_URL = "https://streaming.bitquery.io/graphql";
const ROBINHOOD_CHAIN_ID = "robinhood";
const ROBINHOOD_ENTRY_CONTRACTS = [
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
];
const FOUR_MEME_FACTORY = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const BNB_CHAIN_ID = "bsc";

const RAYDIUM_POOLS_URL = "https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=default&sortType=desc&pageSize=100&page=1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const TRUSTED_SOLANA_QUOTES = new Set([SOL_MINT, ...STABLE_MINTS]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const running = runScan(env);
      ctx.waitUntil(running);
      const result = await running;
      return Response.json(result);
    }
    if (url.pathname === "/status") {
      const [completed, progress] = await Promise.all([
        stateGet(env, "last_scan_status"), stateGet(env, "scan_progress")
      ]);
      const last = JSON.parse(completed || "{}");
      const active = JSON.parse(progress || "{}");
      return Response.json({ ...last, build: BUILD_ID, lastCompletedAt: last.completedAt || last.at || null,
        stale: !last.at || Date.now() - Date.parse(last.completedAt || last.at) > 6 * 60_000,
        progress: active });
    }
    if (url.pathname === "/learning") {
      const records = parseJsonArray(await stateGet(env, "learning_records"));
      return Response.json(buildLearningReport(records));
    }
    if (url.pathname === "/paper") {
      const positions = parseJsonArray(await stateGet(env, "paper_positions"));
      const watch = parseJsonArray(await stateGet(env, "paper_watch"));
      return Response.json(buildPaperReport(positions, watch));
    }
    return Response.json({
      status: "Seekr + Raydium + PumpSwap + Meteora Solana tracker online",
      build: BUILD_ID,
      schedule: "Every 3 minutes, 5:00 a.m.–8:00 p.m. Pacific",
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.STATE),
      robinhoodConfigured: false,
      bnbConfigured: false,
    });
  },

  async scheduled(_controller, env, ctx) {
    if (HEALTH_UPDATE_CRONS.includes(_controller.cron)) {
      // Separate from scan work and its lease: a stuck scan must still be reported.
      return await sendTemporaryHealthUpdate(env, _controller.scheduledTime);
    }
    return await runScan(env);
  },
};

async function sendTemporaryHealthUpdate(env, scheduledTime) {
  const slot = Number(scheduledTime);
  if (!Number.isFinite(slot) || slot < HEALTH_UPDATE_START || slot > HEALTH_UPDATE_END ||
      (slot - HEALTH_UPDATE_START) % 600_000 !== 0 || Date.now() > HEALTH_UPDATE_END + 5 * 60_000) return;
  const marker = "health_update_20261001_" + slot;
  if (await stateGet(env, marker)) return;
  const last = JSON.parse((await stateGet(env, "last_scan_status")) || "{}");
  const progress = JSON.parse((await stateGet(env, "scan_progress")) || "{}");
  await sendTelegram(env, formatScannerHealth(last, progress, slot));
  await statePut(env, "sent", marker);
}

function formatScannerHealth(last, progress, slot, now = Date.now()) {
  const finished = Date.parse(last.completedAt || last.at || "");
  const stale = !Number.isFinite(finished) || now - finished > 6 * 60_000;
  const sourceIssues = Object.entries(last.sources || {}).filter(([, source]) =>
    source?.error || source?.skipped || num(source?.deferred) > 0 ||
    (source?.results || []).some((result) => result.error || result.deferred));
  const activeSourceIssues = sourceIssues.filter(([name]) => !["robinhood", "bnb"].includes(name));
  const issues = [];
  if (stale) issues.push("latest scan is stale or unavailable");
  if (last.ok !== true || last.error) issues.push("scan failed or status unavailable");
  if (num(last.seekrErrors)) issues.push(`${last.seekrErrors} Seekr error(s)`);
  if (num(last.seekrPending)) issues.push(`${last.seekrPending} pending Seekr call(s)`);
  if (num(last.seekrDeferred)) issues.push(`${last.seekrDeferred} deferred Seekr review(s)`);
  if (num(last.dex?.throttled)) issues.push("DexScreener throttled during latest scan");
  if (last.paperError || last.paperSkipped) issues.push("paper tracking interrupted");
  if (last.skipped) issues.push(`scan skipped: ${last.skipped}`);
  for (const [name, source] of activeSourceIssues) {
    issues.push(`${name}: ${source.error || source.skipped || "failed or deferred reviews"}`);
  }
  if (progress.stage === "failed") issues.push("current scan failed");
  const clock = (value) => new Date(value).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
  const lines = [
    `<b>Scanner health — ${clock(slot)} Pacific</b>`,
    issues.length ? "⚠️ Issues detected" : "✅ Latest scan clean",
    `Latest completion: ${Number.isFinite(finished) ? clock(finished) + " Pacific" : "unavailable"}`,
    `Seekr: ${num(last.seekrChecked)} checked; ${num(last.seekrPending)} pending; ${num(last.seekrErrors)} errors`,
    `DexScreener: ${num(last.dex?.requests)} requests; ${num(last.dex?.throttled)} throttled`,
    `Paper: ${esc(last.paperError || last.paperSkipped || "no reported interruption")}`,
    `Progress: ${esc(progress.stage || "unavailable")}`,
  ];
  if (issues.length) lines.push(`Details: ${esc(issues.join("; "))}`);
  lines.push("Latest scan snapshot; does not prove every opportunity was covered.");
  if (slot === HEALTH_UPDATE_END) lines.push("Final temporary health update. Updates now stop.");
  return lines.join("\n");
}

export class State {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/dex-permit" && request.method === "POST") {
      const { priority } = await request.json();
      const result = await this.storage.transaction(async (tx) => {
        const now = Date.now();
        const budget = (await tx.get("dex_budget")) || {};
        if (num(budget.retryAt) > now) return { allowed: false, retryAt: budget.retryAt, reason: "DexScreener provider cooldown" };
        if (now - num(budget.windowAt) >= 60_000) { budget.windowAt = now; budget.count = 0; }
        const limit = priority === "paper" ? 40 : 30;
        if (num(budget.count) >= limit) return { allowed: false, retryAt: budget.windowAt + 60_000, reason: "DexScreener request budget" };
        if (num(budget.nextAt) > now) return { allowed: false, waitMs: budget.nextAt - now };
        budget.count = num(budget.count) + 1;
        budget.nextAt = now + 1_000;
        await tx.put("dex_budget", budget);
        return { allowed: true };
      });
      return Response.json(result);
    }
    if (url.pathname === "/dex-backoff" && request.method === "POST") {
      const { retryAfterMs } = await request.json();
      const result = await this.storage.transaction(async (tx) => {
        const budget = (await tx.get("dex_budget")) || {};
        budget.strikes = Math.min(4, num(budget.strikes) + 1);
        const delay = Math.min(15 * 60_000, Math.max(num(retryAfterMs), 60_000 * (2 ** (budget.strikes - 1))));
        budget.retryAt = Math.max(num(budget.retryAt), Date.now() + delay);
        await tx.put("dex_budget", budget);
        return { retryAt: budget.retryAt };
      });
      return Response.json(result);
    }
    if (url.pathname === "/dex-success" && request.method === "POST") {
      await this.storage.transaction(async (tx) => {
        const budget = (await tx.get("dex_budget")) || {};
        budget.strikes = 0;
        budget.retryAt = 0;
        await tx.put("dex_budget", budget);
      });
      return new Response("ok");
    }
    if (url.pathname === "/acquire" && request.method === "POST") {
      const token = await request.text();
      const acquired = await this.storage.transaction(async (tx) => {
        const lease = await tx.get("scan_lease");
        const now = Date.now();
        // Older builds used ten-minute leases. Bound orphaned legacy leases as
        // well, so a terminated paper update cannot suppress several cron runs.
        const startedAt = lease?.startedAt ?? (lease ? lease.until - 10 * 60_000 : 0);
        if (lease && Math.min(lease.until, startedAt + 4 * 60_000) > now) return false;
        await tx.put("scan_lease", { token, startedAt: now, until: now + 4 * 60_000 });
        return true;
      });
      return Response.json({ acquired });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const token = await request.text();
      await this.storage.transaction(async (tx) => {
        const lease = await tx.get("scan_lease");
        if (lease?.token === token) await tx.delete("scan_lease");
      });
      return new Response("ok");
    }
    if (url.pathname === "/get") {
      const key = safeStateKey(url.searchParams.get("key") || "last_message_id");
      return new Response(String((await this.storage.get(key)) || ""));
    }
    if (url.pathname === "/put" && request.method === "POST") {
      const key = safeStateKey(url.searchParams.get("key") || "last_message_id");
      await this.storage.put(key, await request.text());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }
}

function safeStateKey(value) {
  if (!/^[a-z0-9_]{1,64}$/i.test(value)) throw new Error("Invalid state key");
  return value;
}

async function stateGet(env, key = "last_message_id") {
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  return stub.fetch(`https://state/get?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) }).then(check).then((r) => r.text());
}

async function statePut(env, value, key = "last_message_id") {
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  const response = await stub.fetch(`https://state/put?key=${encodeURIComponent(key)}`, { method: "POST", body: String(value), signal: AbortSignal.timeout(10_000) });
  await check(response);
  await response.text();
}

async function runScan(env) {
  env = { ...env, _scanDeadline: Date.now() + 150_000, _dex: { cache: new Map(), confirmations: new Map(), sharedConfirmations: 0, requests: 0, cacheHits: 0, throttled: 0, priority: "discovery" } };
  const at = new Date().toISOString();
  if (!env.STATE) return { ok: false, at, error: "Missing STATE binding" };
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  const token = crypto.randomUUID();
  const lease = await stub.fetch("https://state/acquire", { method: "POST", body: token }).then((r) => r.json());
  if (!lease.acquired) return { ok: true, at, skipped: "Scan already running" };
  try {
    await scanProgress(env, "starting", at);
    const result = await scan(env);
    const status = { at, completedAt: new Date().toISOString(), ok: result.ok, seekrChecked: result.seekrChecked ?? 0,
      seekrErrors: (result.seekrResults || []).filter((item) => item.error).length,
      seekrDeferred: result.seekrDeferred ?? 0,
      seekrPending: result.seekrPending ?? 0, seekrRetryAt: result.seekrRetryAt || null,
      seekrFailures: (result.seekrResults || []).filter((item) => item.error)
        .slice(0, 3).map((item) => ({ contract: item.contract, error: item.error })),
      sources: { raydium: result.raydium, pumpSwap: result.pumpSwap, meteora: result.meteora,
        robinhood: result.robinhood, bnb: result.bnb }, paperError: result.paper?.error || null,
      error: result.error || null, skipped: result.skipped || null,
      dex: { requests: env._dex.requests, cacheHits: env._dex.cacheHits, sharedConfirmations: env._dex.sharedConfirmations, throttled: env._dex.throttled,
        retryAt: env._dex.retryAt || null }, paperSkipped: result.paper?.skipped || null };
    await statePut(env, JSON.stringify(status), "last_scan_status").catch(console.error);
    await scanProgress(env, "completed", at);
    return result;
  } catch (error) {
    const result = { ok: false, at, completedAt: new Date().toISOString(), error: String(error) };
    console.error("Scan failed", error);
    await scanProgress(env, "failed", at, String(error)).catch(console.error);
    await statePut(env, JSON.stringify(result), "last_scan_status").catch(console.error);
    return result;
  } finally {
    await stub.fetch("https://state/release", { method: "POST", body: token, signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(console.error);
  }
}

async function scanProgress(env, stage, startedAt = env._scanStartedAt, error = null) {
  env._scanStartedAt = startedAt;
  await statePut(env, JSON.stringify({ stage, startedAt, updatedAt: new Date().toISOString(),
    deadlineAt: new Date(env._scanDeadline).toISOString(), error }), "scan_progress");
}

function scanHasTime(env, reserveMs = 0) {
  return !env?._scanDeadline || Date.now() + reserveMs < env._scanDeadline;
}

async function scan(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.STATE) {
    return { ok: false, error: "Missing Telegram secrets or STATE binding" };
  }
  if (!insidePacificWindow()) {
    const learning = await updateLearningOutcomes(env).catch((error) => ({ error: String(error) }));
    const paper = await updatePaperLedgerSafe(env);
    await maybeSendDailyPaperReport(env, paper).catch(console.error);
    return { ok: true, skipped: "Outside active hours", learning, paper };
  }

  // Price tracking must run before potentially slow discovery or safety checks.
  env._dex && (env._dex.priority = "paper");
  await scanProgress(env, "paper");
  const paper = await updatePaperLedgerSafe(env);
  env._dex && (env._dex.priority = "discovery");
  await maybeSendDailyPaperReport(env, paper).catch(console.error);
  await scanProgress(env, "seekr-feed");
  const html = await fetch(`https://t.me/s/${CHANNEL}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "Mozilla/5.0 SeekrTracker/1.0" },
  }).then(check).then((r) => r.text());

  const calls = parseCalls(html);
  let lastId = Number(await stateGet(env)) || 0;
  const newestId = calls.reduce((n, c) => Math.max(n, c.id), lastId);
  let connected = false;

  // First run establishes a baseline so old calls do not flood Telegram.
  if (!lastId) {
    await statePut(env, newestId);
    connected = true;
  }

  const fresh = lastId ? calls.filter((c) => c.id > lastId).sort((a, b) => a.id - b.id) : [];
  const savedPending = parseJsonArray(await stateGet(env, "seekr_pending_calls"));
  const pendingById = new Map(savedPending.filter((c) => c?.id && c?.contract).map((c) => [c.id, c]));
  for (const call of fresh) pendingById.set(call.id, call);
  // Keep one pending review per exact token; repeated source posts must not inflate the queue.
  const pending = [...pendingById.values()].sort((a, b) => a.id - b.id)
    .filter((call, index, all) => all.findIndex((item) => item.contract === call.contract) === index);
  // Save calls before moving the cursor so an interrupted scan cannot lose them.
  await statePut(env, JSON.stringify(pending), "seekr_pending_calls");
  if (newestId > lastId) await statePut(env, newestId);
  const results = [];
  const seekrRetryAt = Number(await stateGet(env, "seekr_provider_retry_at")) || 0;
  const seekrBatch = Date.now() < seekrRetryAt ? [] : pending.slice(0, 15);
  let seekrDexDeferred = false;
  if (seekrBatch.length) {
    try {
      await getBestPairs(seekrBatch.map((call) => call.contract), "solana", env);
    } catch (error) {
      if (isDexDeferral(error)) {
        seekrDexDeferred = true;
        await persistSeekrDexRetry(env);
      } else {
        throw error;
      }
    }
  }
  await scanProgress(env, "seekr-reviews");
  let seekrSafetyChecks = 0;
  for (const call of seekrDexDeferred ? [] : seekrBatch) {
    if (!scanHasTime(env, 55_000)) break;
    try {
      const pair = await getBestPair(call.contract, null, "solana", env);
      // After the one expensive safety slot is used, cheaply drain obvious
      // market failures and rotate plausible candidates to the next scan.
      if (seekrSafetyChecks >= 1) {
        const initialReview = scorePair(call, pair, "Solana");
        if (passesMarketSafety(initialReview)) {
          results.push({ contract: call.contract, deferred: true,
            marketGate: "initial market gate passed; waiting for next safety slot" });
          const deferredIndex = pending.findIndex((item) => item.id === call.id);
          if (deferredIndex >= 0) pending.push(...pending.splice(deferredIndex, 1));
          await statePut(env, JSON.stringify(pending), "seekr_pending_calls");
          continue;
        }
        const confirmation = { passed: false, pair, review: initialReview,
          initialReview, summary: "blocked by initial momentum gate" };
        const safety = { passed: false, scorePenalty: 0, summary: "skipped: market gate failed" };
        results.push({ contract: call.contract, alerted: false, score: initialReview.score,
          rawScore: initialReview.score, safety: safety.summary, marketGate: confirmation.summary });
        await recordLearningObservation(env, call, initialReview, safety, confirmation, false).catch(() => {});
        const failedIndex = pending.findIndex((item) => item.id === call.id);
        if (failedIndex >= 0) pending.splice(failedIndex, 1);
        await statePut(env, JSON.stringify(pending), "seekr_pending_calls");
        continue;
      }
      if (passesMarketSafety(scorePair(call, pair, "Solana"))) seekrSafetyChecks += 1;
      const confirmation = await confirmMarketMomentum(call, pair, { env });
      const review = confirmation.review;
      // A failed market gate cannot alert; avoid spending a safety API call on it.
      const safety = confirmation.passed
        ? await getSolanaSafety(call.contract, env)
        : { passed: false, scorePenalty: 0, summary: "skipped: market gate failed" };
      if (safety.summary?.includes("safety report unavailable")) throw new Error(safety.summary);
      const effectiveScore = review.score - num(safety.scorePenalty);
      const alerted = safety.passed && confirmation.passed && effectiveScore >= MIN_SCORE && review.marketCap <= MAX_MARKET_CAP;
      if (alerted) {
        await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, score: effectiveScore, safety, confirmation }));
        results.push({ contract: call.contract, alerted: true, score: effectiveScore, rawScore: review.score, safety: safety.summary });
      } else {
        results.push({ contract: call.contract, alerted: false, score: effectiveScore, rawScore: review.score, safety: safety.summary, marketGate: confirmation.summary });
      }
      await recordLearningObservation(env, call, review, safety, confirmation, alerted).catch(() => {});
      const index = pending.findIndex((item) => item.id === call.id);
      if (index >= 0) pending.splice(index, 1);
      await statePut(env, JSON.stringify(pending), "seekr_pending_calls");
    } catch (error) {
      const index = pending.findIndex((item) => item.id === call.id);
      if (index >= 0) pending.push(...pending.splice(index, 1));
      await statePut(env, JSON.stringify(pending), "seekr_pending_calls");
      if (isDexDeferral(error)) {
        await persistSeekrDexRetry(env);
        break;
      }
      results.push({ contract: call.contract, error: String(error) });
      if (String(error).includes("429")) {
        await statePut(env, Date.now() + 2 * 60_000, "seekr_provider_retry_at");
        break;
      }
    }
  }
  await scanProgress(env, "solana-discovery");
  const solanaMomentum = scanHasTime(env, 45_000) ? await scanSolanaMomentum(env)
    : { raydium: { skipped: "Scan time budget" }, pumpSwap: { skipped: "Scan time budget" }, meteora: { skipped: "Scan time budget" } };
  const robinhood = { configured: false, checked: 0, skipped: "Solana-only mode" };
  const bnb = { configured: false, checked: 0, skipped: "Solana-only mode" };
  await scanProgress(env, "learning");
  const learning = scanHasTime(env, 20_000) ? await updateLearningOutcomes(env).catch((error) => ({ error: String(error) }))
    : { skipped: "Scan time budget" };
  if (connected) {
    await sendTelegram(env, `✅ Seekr + Raydium + PumpSwap + Meteora Solana tracker connected. Build: <code>${BUILD_ID}</code>. Scanning every 3 minutes from 5:00 a.m. to 8:00 p.m. Pacific.`);
  }
  return { ok: true, build: BUILD_ID, seekrChecked: results.length, seekrDeferred: seekrDexDeferred ? seekrBatch.length : 0,
    seekrPending: pending.length,
    seekrRetryAt: Date.now() < (Number(await stateGet(env, "seekr_provider_retry_at")) || 0)
      ? new Date(Number(await stateGet(env, "seekr_provider_retry_at"))).toISOString() : null,
    seekrResults: results, ...solanaMomentum, robinhood, bnb, learning, paper };
}

function isDexDeferral(error) {
  const message = String(error);
  return message.includes("DexScreener provider cooldown") ||
    message.includes("DexScreener request budget") ||
    message.includes("api.dexscreener.com HTTP 429") ||
    message.includes("shared cooldown");
}

async function persistSeekrDexRetry(env) {
  const retryAt = Date.parse(env?._dex?.retryAt || "");
  const fallback = Date.now() + 2 * 60_000;
  await statePut(env, Number.isFinite(retryAt) ? retryAt + 1_000 : fallback, "seekr_provider_retry_at");
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500) throw new Error(`${response.url ? new URL(response.url).hostname : "unknown provider"} HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 1_000 * (2 ** attempt);
      lastError = new Error(`${response.url ? new URL(response.url).hostname : "unknown provider"} HTTP ${response.status}`);
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Request failed");
}

async function getSolanaMomentumPayloads(env) {
  const requestJson = (url, options = {}, attempts = 3) =>
    new URL(url).hostname === "api.dexscreener.com"
      ? dexJson(env, url, options)
      : fetchJsonWithRetry(url, options, attempts);
  try {
    const payload = await requestJson(
      "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&page=1",
      { headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" } },
      2
    );
    return { payloads: [payload], source: "geckoterminal" };
  } catch (geckoError) {
    const [profileResult, boostResult] = await Promise.allSettled([
      requestJson("https://api.dexscreener.com/token-profiles/recent-updates/v1", {
        headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" },
      }, 2),
      requestJson("https://api.dexscreener.com/token-boosts/latest/v1", {
        headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" },
      }, 2),
    ]);
    const profiles = profileResult.status === "fulfilled" ? profileResult.value : [];
    const boosts = boostResult.status === "fulfilled" ? boostResult.value : [];
    if (!profiles.length && !boosts.length) throw new Error(`All Solana discovery providers failed: GeckoTerminal ${String(geckoError)}; profiles ${String(profileResult.reason)}; boosts ${String(boostResult.reason)}`);
    const addresses = [...new Set([...profiles, ...boosts]
      .filter((item) => item?.chainId === "solana")
      .map((item) => String(item?.tokenAddress || ""))
      .filter((address) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    )].slice(0, 30);
    if (!addresses.length) throw new Error(`GeckoTerminal unavailable (${String(geckoError)}); DexScreener fallback returned no Solana tokens`);
    const pairs = await requestJson(
      `https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`,
      { headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" } },
      2
    );
    const included = new Map();
    const data = [];
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      const contract = String(pair?.baseToken?.address || "");
      const quote = String(pair?.quoteToken?.address || "");
      if (!addresses.includes(contract) || !TRUSTED_SOLANA_QUOTES.has(quote)) continue;
      const dexId = String(pair?.dexId || "").toLowerCase();
      if (!["pumpswap", "meteora", "raydium"].includes(dexId)) continue;
      const tokenId = `solana_${contract}`;
      included.set(tokenId, {
        id: tokenId,
        type: "token",
        attributes: { address: contract, name: pair?.baseToken?.name, symbol: pair?.baseToken?.symbol },
      });
      data.push({
        id: pair?.pairAddress,
        type: "pool",
        attributes: {
          market_cap_usd: pair?.marketCap,
          fdv_usd: pair?.fdv,
          reserve_in_usd: pair?.liquidity?.usd,
          volume_usd: { h1: pair?.volume?.h1 },
          transactions: { h1: { buys: pair?.txns?.h1?.buys, sells: pair?.txns?.h1?.sells } },
          price_change_percentage: { m5: pair?.priceChange?.m5, h1: pair?.priceChange?.h1, h6: pair?.priceChange?.h6 },
          name: pair?.baseToken?.name,
        },
        relationships: {
          dex: { data: { id: dexId } },
          base_token: { data: { id: tokenId } },
          quote_token: { data: { id: `solana_${quote}` } },
        },
      });
    }
    return { payloads: [{ data, included: [...included.values()] }], source: "dexscreener-fallback", geckoError: String(geckoError) };
  }
}

async function scanSolanaMomentum(env) {
  const now = Date.now();
  const nextAttempt = Number(await stateGet(env, "solana_next_attempt")) || 0;
  if (now < nextAttempt) {
    const deferred = { discovered: 0, checked: 0, skipped: "Provider cooldown", retryAt: new Date(nextAttempt).toISOString() };
    return { raydium: deferred, pumpSwap: deferred, meteora: deferred };
  }
  try {
    const discovery = await getSolanaMomentumPayloads(env);
    const payloads = discovery.payloads;
    await statePut(env, now + 3 * 60_000, "solana_next_attempt");
    const currentAlerts = parseJsonArray(await stateGet(env, "solana_momentum_alerted"));
    const legacyPumpSwapAlerts = parseJsonArray(await stateGet(env, "pumpswap_alerted"));
    const alertHistory = [...currentAlerts, ...legacyPumpSwapAlerts]
      .filter((item) => item?.contract && now - num(item.alertedAt) < PUMPSWAP_ALERT_COOLDOWN_MS)
      .filter((item, index, all) => all.findIndex((other) => other.contract === item.contract) === index);
    // Run sequentially against shared history so the same token cannot alert once
    // from Raydium, PumpSwap, and Meteora during a single scheduled scan.
    const raydium = await processSolanaMomentumDex(env, payloads, {
      dexId: "raydium",
      source: "RAYDIUM",
      fallbackName: "Raydium token",
    }, alertHistory, now);
    const pumpSwap = await processSolanaMomentumDex(env, payloads, {
      dexId: "pumpswap",
      source: "PUMPSWAP",
      fallbackName: "PumpSwap token",
    }, alertHistory, now);
    const meteora = await processSolanaMomentumDex(env, payloads, {
      dexId: "meteora",
      source: "METEORA",
      fallbackName: "Meteora token",
    }, alertHistory, now);
    await statePut(env, JSON.stringify(alertHistory.slice(-300)), "solana_momentum_alerted");
    return { raydium, pumpSwap, meteora };
  } catch (error) {
    await statePut(env, now + (String(error).includes("429") ? 15 : 9) * 60_000, "solana_next_attempt").catch(console.error);
    const failure = { discovered: 0, checked: 0, error: String(error) };
    return { raydium: failure, pumpSwap: failure, meteora: failure };
  }
}

async function processSolanaMomentumDex(env, payloads, config, alertHistory, now) {
  try {
    const tokens = new Map();
    for (const payload of payloads) {
      const included = new Map((payload?.included || []).map((item) => [item.id, item?.attributes || {}]));
      for (const pool of payload?.data || []) {
        const discoveredDexId = String(pool?.relationships?.dex?.data?.id || "").toLowerCase();
        const quoteId = String(pool?.relationships?.quote_token?.data?.id || "").replace(/^solana_/, "");
        const trustedQuote = TRUSTED_SOLANA_QUOTES.has(quoteId);
        const directDiscovery = discoveredDexId === config.dexId && trustedQuote;
        // A PumpSwap token-to-token pool may nominate a token for Meteora review,
        // but it can never validate the alert. getBestPair below must still find
        // a separate Meteora SOL/USDC/USDT pool and confirm it twice.
        const pumpSwapLeadForMeteora = config.dexId === "meteora" && discoveredDexId === "pumpswap";
        if (!directDiscovery && !pumpSwapLeadForMeteora) continue;
        const attributes = pool?.attributes || {};
        const marketCap = num(attributes.market_cap_usd) || num(attributes.fdv_usd);
        const liquidity = num(attributes.reserve_in_usd);
        const h1 = attributes?.transactions?.h1 || {};
        const buys = num(h1.buys);
        const sells = num(h1.sells);
        const buyers = num(h1.buyers);
        const volumeH1 = num(attributes?.volume_usd?.h1);
        const changeM5 = num(attributes?.price_change_percentage?.m5);
        const changeH1 = num(attributes?.price_change_percentage?.h1);
        const changeH6 = num(attributes?.price_change_percentage?.h6);
        const momentum = Math.max(changeM5, changeH1, changeH6);
        if (marketCap <= 0 || marketCap > MAX_PUMPSWAP_MARKET_CAP) continue;
        if (liquidity < MIN_LIQUIDITY || volumeH1 < PUMPSWAP_MIN_H1_VOLUME) continue;
        if (buys < PUMPSWAP_MIN_H1_BUYS || (buyers > 0 && buyers < PUMPSWAP_MIN_H1_BUYERS)) continue;
        if (buys / Math.max(1, sells) < PUMPSWAP_MIN_BUY_SELL_RATIO || momentum < PUMPSWAP_MIN_MOMENTUM_PCT) continue;
        const tokenId = String(pool?.relationships?.base_token?.data?.id || "");
        const token = included.get(tokenId) || {};
        const contract = String(token.address || tokenId.replace(/^solana_/, ""));
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contract)) continue;
        const existing = tokens.get(contract);
        if (!existing || volumeH1 > existing.volumeH1) {
          tokens.set(contract, {
            contract,
            name: token.name || token.symbol || attributes.name || config.fallbackName,
            paid: false,
            source: config.source,
            volumeH1,
            momentum,
          });
        }
      }
    }

    const lastAlert = new Map(alertHistory.map((item) => [String(item.contract), num(item.alertedAt)]));
    const candidates = [...tokens.values()]
      .filter((item) => !lastAlert.has(item.contract))
      .sort((a, b) => b.volumeH1 - a.volumeH1)
      // Keep total Rugcheck usage below the provider limit while Seekr drains.
      .slice(0, 2);
    const results = [];
    for (const call of candidates) {
      if (!scanHasTime(env, 45_000)) break;
      try {
        const pair = await getBestPair(call.contract, config.dexId, "solana", env);
        const confirmation = await confirmMarketMomentum(call, pair, { dexId: config.dexId, env });
        const review = confirmation.review;
        // Do not spend a scarce Rugcheck request on a token that already failed
        // the market/momentum confirmation.
        const safety = confirmation.passed
          ? await getSolanaSafety(call.contract, env)
          : { passed: false, scorePenalty: 0, summary: "skipped: market gate failed" };
        const effectiveScore = review.score - num(safety.scorePenalty);
        const alerted = Boolean(pair && safety.passed && confirmation.passed && effectiveScore >= MIN_SCORE && review.marketCap <= MAX_PUMPSWAP_MARKET_CAP);
        if (alerted) {
          await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, score: effectiveScore, safety, confirmation }));
          alertHistory.push({ contract: call.contract, alertedAt: now });
          results.push({ contract: call.contract, alerted: true, score: effectiveScore, rawScore: review.score, safety: safety.summary });
        } else {
          results.push({ contract: call.contract, alerted: false, score: effectiveScore, rawScore: review.score, safety: safety.summary, marketGate: confirmation.summary });
        }
        await recordLearningObservation(env, call, review, safety, confirmation, alerted).catch(() => {});
      } catch (error) {
        results.push({ contract: call.contract, error: String(error) });
      }
    }
    return { discovered: tokens.size, checked: results.length, deferred: candidates.length - results.length, results };
  } catch (error) {
    return { discovered: 0, checked: 0, error: String(error) };
  }
}

async function scanBnb(env) {
  if (!env.BITQUERY_TOKEN) return { configured: false, checked: 0, message: "Add BITQUERY_TOKEN to enable" };
  const retryAt = Number(await stateGet(env, "bnb_provider_retry_at")) || 0;
  if (Date.now() < retryAt) return { configured: true, checked: 0, skipped: "Provider HTTP 402 cooldown", retryAt: new Date(retryAt).toISOString() };
  try {
    const launches = await getBnbLaunches(env.BITQUERY_TOKEN);
    const now = Date.now();
    const savedWatch = parseJsonArray(await stateGet(env, "bnb_watch"));
    const savedAlerted = new Set(parseJsonArray(await stateGet(env, "bnb_alerted")));
    const watch = new Map();
    for (const item of savedWatch) {
      if (item?.contract && now - num(item.firstSeen) < 3 * 60 * 60 * 1000) watch.set(String(item.contract).toLowerCase(), item);
    }
    for (const item of launches) {
      const key = item.contract.toLowerCase();
      if (!savedAlerted.has(key) && !watch.has(key)) watch.set(key, { ...item, firstSeen: now });
    }
    const results = [];
    const candidates = [...watch.values()].slice(0, 20);
    const contracts = candidates.map((item) => item.contract);
    const [pairs, safeties] = await Promise.all([
      getBestPairs(contracts, BNB_CHAIN_ID, env),
      getBnbSafeties(contracts),
    ]);
    for (const item of candidates) {
      const key = item.contract.toLowerCase();
      try {
        const pair = pairs.get(key) || null;
        const safety = safeties.get(key) || { passed: false, summary: "GoPlus data unavailable" };
        const call = { ...item, name: item.name || pair?.baseToken?.name || pair?.baseToken?.symbol || "BNB token", paid: false, source: "BNB" };
        const confirmation = await confirmMarketMomentum(call, pair, { chainId: BNB_CHAIN_ID, chainName: "BNB Chain", env });
        const review = confirmation.review;
        if (pair && safety.passed && confirmation.passed && review.score >= BNB_MIN_SCORE && review.marketCap <= MAX_MARKET_CAP) {
          await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, safety, confirmation }));
          await recordPaperWatch(env, call, review);
          savedAlerted.add(key);
          watch.delete(key);
          results.push({ contract: item.contract, alerted: true, score: review.score, safety: safety.summary });
        } else results.push({ contract: item.contract, alerted: false, score: review.score, safety: safety.summary, marketGate: confirmation.summary });
      } catch (error) {
        results.push({ contract: item.contract, error: String(error) });
      }
    }
    await statePut(env, JSON.stringify([...watch.values()].slice(0, 100)), "bnb_watch");
    await statePut(env, JSON.stringify([...savedAlerted].slice(-500)), "bnb_alerted");
    return { configured: true, launches: launches.length, checked: candidates.length, results };
  } catch (error) {
    if (String(error).includes("402")) await statePut(env, Date.now() + 60 * 60_000, "bnb_provider_retry_at").catch(console.error);
    return { configured: true, checked: 0, error: String(error) };
  }
}

async function getBnbLaunches(token) {
  const query = `{
    EVM(dataset: realtime, network: bsc) {
      Events(
        limit: {count: 25}
        orderBy: {descending: Block_Time}
        where: {
          Transaction: {To: {is: "${FOUR_MEME_FACTORY}"}}
          Log: {Signature: {Name: {is: "TokenCreate"}}}
        }
      ) {
        Block { Time Number }
        Transaction { Hash From }
        Arguments {
          Name
          Value {
            ... on EVM_ABI_Address_Value_Arg { address }
            ... on EVM_ABI_String_Value_Arg { string }
          }
        }
      }
    }
  }`;
  const response = await fetch(BITQUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  const payload = await check(response).then((r) => r.json());
  if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
  const unique = new Map();
  for (const event of payload?.data?.EVM?.Events || []) {
    const args = Object.fromEntries((event.Arguments || []).map((arg) => [String(arg?.Name || "").toLowerCase(), arg?.Value]));
    const contract = args.token?.address;
    if (!/^0x[a-f0-9]{40}$/i.test(contract || "")) continue;
    unique.set(contract.toLowerCase(), {
      contract,
      creator: args.creator?.address || event?.Transaction?.From || null,
      name: args.name?.string || args.symbol?.string || "Four.meme token",
      symbol: args.symbol?.string || null,
      launchTx: event?.Transaction?.Hash || null,
      launchedAt: event?.Block?.Time || null,
      launchSource: "Four.meme",
    });
  }
  return [...unique.values()];
}

async function getBnbSafety(contract) {
  return (await getBnbSafeties([contract])).get(contract.toLowerCase()) || { passed: false, summary: "GoPlus data unavailable" };
}

async function getBnbSafeties(contracts) {
  const results = new Map();
  if (!contracts.length) return results;
  const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${encodeURIComponent(contracts.join(","))}`;
  const response = await fetch(url, { headers: { "User-Agent": "SeekrBnbTracker/1.0" } });
  const payload = await check(response).then((r) => r.json());
  for (const contract of contracts) {
    const key = contract.toLowerCase();
    const data = payload?.result?.[key];
    results.set(key, reviewBnbSafety(data));
  }
  return results;
}

function reviewBnbSafety(data) {
  if (!data) return { passed: false, summary: "GoPlus data unavailable" };
  const buyTax = taxPercent(data.buy_tax);
  const sellTax = taxPercent(data.sell_tax);
  const blockers = [];
  if (data.is_honeypot === "1") blockers.push("honeypot flag");
  if (data.cannot_sell_all === "1") blockers.push("cannot sell all");
  if (data.is_blacklisted === "1") blockers.push("blacklist flag");
  if (data.transfer_pausable === "1") blockers.push("transfers pausable");
  if (data.owner_change_balance === "1") blockers.push("owner can alter balances");
  if (data.is_open_source === "0") blockers.push("closed source");
  if (buyTax > 10) blockers.push(`buy tax ${buyTax.toFixed(1)}%`);
  if (sellTax > 10) blockers.push(`sell tax ${sellTax.toFixed(1)}%`);
  const summary = blockers.length ? `blocked: ${blockers.join(", ")}` : `passed; tax ${buyTax.toFixed(1)}% buy / ${sellTax.toFixed(1)}% sell`;
  return { passed: blockers.length === 0, summary, buyTax, sellTax };
}

function taxPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n * 100 : 0;
}

async function scanRobinhood(env) {
  if (!env.BITQUERY_TOKEN) return { configured: false, checked: 0, message: "Add BITQUERY_TOKEN to enable" };
  const retryAt = Number(await stateGet(env, "robinhood_provider_retry_at")) || 0;
  if (Date.now() < retryAt) return { configured: true, checked: 0, skipped: "Provider HTTP 402 cooldown", retryAt: new Date(retryAt).toISOString() };

  try {
    const launches = await getRobinhoodLaunches(env.BITQUERY_TOKEN);
    const now = Date.now();
    const savedWatch = parseJsonArray(await stateGet(env, "robinhood_watch"));
    const savedAlerted = new Set(parseJsonArray(await stateGet(env, "robinhood_alerted")));
    const watch = new Map();

    for (const item of savedWatch) {
      if (item?.contract && now - num(item.firstSeen) < 3 * 60 * 60 * 1000) {
        watch.set(String(item.contract).toLowerCase(), item);
      }
    }
    for (const item of launches) {
      const key = item.contract.toLowerCase();
      if (!savedAlerted.has(key) && !watch.has(key)) watch.set(key, { ...item, firstSeen: now });
    }

    const results = [];
    for (const item of [...watch.values()].slice(0, 40)) {
      const key = item.contract.toLowerCase();
      try {
        const pair = await getBestPair(item.contract, null, ROBINHOOD_CHAIN_ID, env);
        const call = { ...item, name: pair?.baseToken?.name || pair?.baseToken?.symbol || "Robinhood token", paid: false, source: "ROBINHOOD" };
        const confirmation = await confirmMarketMomentum(call, pair, { chainId: ROBINHOOD_CHAIN_ID, chainName: "Robinhood Chain", env });
        const review = confirmation.review;
        if (pair && confirmation.passed && review.score >= ROBINHOOD_MIN_SCORE && review.marketCap <= MAX_MARKET_CAP) {
          await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, confirmation }));
          await recordPaperWatch(env, call, review);
          savedAlerted.add(key);
          watch.delete(key);
          results.push({ contract: item.contract, alerted: true, score: review.score });
        } else {
          results.push({ contract: item.contract, alerted: false, score: review.score, marketGate: confirmation.summary });
        }
      } catch (error) {
        results.push({ contract: item.contract, error: String(error) });
      }
    }

    await statePut(env, JSON.stringify([...watch.values()].slice(0, 100)), "robinhood_watch");
    await statePut(env, JSON.stringify([...savedAlerted].slice(-500)), "robinhood_alerted");
    return { configured: true, launches: launches.length, checked: Math.min(watch.size + savedAlerted.size, 40), results };
  } catch (error) {
    if (String(error).includes("402")) await statePut(env, Date.now() + 60 * 60_000, "robinhood_provider_retry_at").catch(console.error);
    return { configured: true, checked: 0, error: String(error) };
  }
}

async function getRobinhoodLaunches(token) {
  const query = `{
    EVM(network: robinhood) {
      Events(
        limit: {count: 25}
        orderBy: {descending: Block_Time}
        where: {
          LogHeader: {Address: {in: [${ROBINHOOD_ENTRY_CONTRACTS.map((a) => `"${a}"`).join(",")} ]}}
          Log: {Signature: {Name: {is: "TokenCreated"}}}
        }
      ) {
        Block { Time Number }
        Transaction { Hash From }
        Arguments {
          Name
          Value { ... on EVM_ABI_Address_Value_Arg { address } }
        }
      }
    }
  }`;
  const response = await fetch(BITQUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  const payload = await check(response).then((r) => r.json());
  if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
  const events = payload?.data?.EVM?.Events || [];
  const unique = new Map();
  for (const event of events) {
    const arg = (event.Arguments || []).find((a) => a?.Value?.address);
    const contract = arg?.Value?.address;
    if (!/^0x[a-f0-9]{40}$/i.test(contract || "")) continue;
    unique.set(contract.toLowerCase(), {
      contract,
      creator: event?.Transaction?.From || null,
      launchTx: event?.Transaction?.Hash || null,
      launchedAt: event?.Block?.Time || null,
    });
  }
  return [...unique.values()];
}

async function scanRaydium(env) {
  try {
    const payload = await fetch(RAYDIUM_POOLS_URL, {
      headers: { "User-Agent": "SeekrRaydiumTracker/1.0" },
    }).then(check).then((r) => r.json());
    const pools = Array.isArray(payload?.data?.data)
      ? payload.data.data
      : Array.isArray(payload?.data) ? payload.data : [];

    const candidates = [];
    const added = new Set();
    for (const pool of pools) {
      const tags = JSON.stringify(pool?.tags || []).toLowerCase();
      if (tags.includes("scam") || tags.includes("honeypot")) continue;
      const mints = [pool?.mintA, pool?.mintB];
      for (const mint of mints) {
        const address = mint?.address || mint?.mint || mint?.id;
        if (!address || address === SOL_MINT || STABLE_MINTS.has(address) || added.has(address)) continue;
        added.add(address);
        candidates.push({
          contract: address,
          name: mint?.name || mint?.symbol || "Raydium token",
          paid: false,
          source: "RAYDIUM",
        });
      }
    }

    const saved = await stateGet(env, "raydium_seen");
    const seen = new Set(parseJsonArray(saved));
    const current = candidates.map((c) => c.contract);
    if (!seen.size) {
      await statePut(env, JSON.stringify(current.slice(0, 300)), "raydium_seen");
      return { baseline: current.length, checked: 0, results: [] };
    }

    const fresh = candidates.filter((c) => !seen.has(c.contract)).slice(0, 30);
    const results = [];
    for (const call of fresh) {
      try {
        const pair = await getBestPair(call.contract, "raydium", "solana", env);
        const confirmation = await confirmMarketMomentum(call, pair, { dexId: "raydium", env });
        const review = confirmation.review;
        const safety = await getSolanaSafety(call.contract, env);
        const effectiveScore = review.score - num(safety.scorePenalty);
        const alerted = Boolean(pair && safety.passed && confirmation.passed && effectiveScore >= MIN_SCORE && review.marketCap <= MAX_MARKET_CAP);
        if (alerted) {
          await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, score: effectiveScore, safety, confirmation }));
          results.push({ contract: call.contract, alerted: true, score: effectiveScore, rawScore: review.score, safety: safety.summary });
        } else {
          results.push({ contract: call.contract, alerted: false, score: effectiveScore, rawScore: review.score, safety: safety.summary, marketGate: confirmation.summary });
        }
        await recordLearningObservation(env, call, review, safety, confirmation, alerted).catch(() => {});
      } catch (error) {
        results.push({ contract: call.contract, error: String(error) });
      }
    }

    const nextSeen = [...current, ...seen].filter((v, i, a) => a.indexOf(v) === i).slice(0, 300);
    await statePut(env, JSON.stringify(nextSeen), "raydium_seen");
    return { checked: fresh.length, results };
  } catch (error) {
    return { checked: 0, error: String(error) };
  }
}

async function recordLearningObservation(env, call, review, safety, confirmation, alerted) {
  if (!call?.contract || !Number.isFinite(review?.marketCap) || review.marketCap <= 0) return;
  if (alerted) await recordPaperWatch(env, call, review);
  const now = Date.now();
  const records = parseJsonArray(await stateGet(env, "learning_records"));
  let record = records.find((item) =>
    item?.contract === call.contract && now - num(item.entryAt) < 12 * 60 * 60 * 1000
  );
  const snapshot = {
    marketCap: num(review.marketCap),
    liquidity: num(review.liquidity),
    volumeH1: num(review.volumeH1),
    buys: num(review.buys),
    sells: num(review.sells),
  };
  if (!record) {
    record = {
      id: `${call.contract}:${Math.floor(now / (12 * 60 * 60 * 1000))}`,
      contract: call.contract,
      name: String(call.name || "Unknown").slice(0, 80),
      source: call.source || "SEEKR",
      chainId: paperChainId(call.source),
      entryAt: now,
      alerted: Boolean(alerted),
      rawScore: num(review.score),
      effectiveScore: num(review.score) - num(safety?.scorePenalty),
      entry: snapshot,
      safetyPassed: Boolean(safety?.passed),
      safety: String(safety?.summary || "").slice(0, 240),
      marketPassed: Boolean(confirmation?.passed),
      marketGate: String(confirmation?.summary || "").slice(0, 160),
      reasons: (review.reasons || []).slice(0, 6),
      checkpoints: {},
      minMultiple: 1,
      maxMultiple: 1,
      missingSamples: 0,
      outcome: "tracking",
    };
    records.push(record);
  } else if (alerted && !record.alerted) {
    record.alerted = true;
    record.entryAt = now;
    record.entry = snapshot;
    record.rawScore = num(review.score);
    record.effectiveScore = num(review.score) - num(safety?.scorePenalty);
    record.checkpoints = {};
    record.minMultiple = 1;
    record.maxMultiple = 1;
    record.missingSamples = 0;
    record.outcome = "tracking";
  }
  record.lastObservedAt = now;
  await statePut(env, JSON.stringify(records.slice(-LEARNING_RECORD_LIMIT)), "learning_records");
}

async function updateLearningOutcomes(env) {
  const now = Date.now();
  const lastUpdate = num(await stateGet(env, "learning_last_update"));
  if (now - lastUpdate < LEARNING_UPDATE_INTERVAL_MS) return { skipped: "recently updated" };
  await statePut(env, now, "learning_last_update");
  const records = parseJsonArray(await stateGet(env, "learning_records"));
  const active = records.filter((record) =>
    record?.contract && num(record.entry?.marketCap) > 0 && now - num(record.entryAt) <= LEARNING_WINDOW_MS + LEARNING_UPDATE_INTERVAL_MS
  );
  const contracts = [...new Set(active.map((record) => record.contract))];
  const pairs = new Map();
  for (let i = 0; i < contracts.length; i += 30) {
    const batch = await getBestPairs(contracts.slice(i, i + 30), "solana", env);
    for (const [contract, pair] of batch) pairs.set(contract, pair);
  }
  const checkpoints = [
    ["m15", 15 * 60 * 1000],
    ["h1", 60 * 60 * 1000],
    ["h6", 6 * 60 * 60 * 1000],
    ["h24", 24 * 60 * 60 * 1000],
  ];
  for (const record of active) {
    const pair = pairs.get(String(record.contract).toLowerCase());
    if (!pair) {
      record.missingSamples = num(record.missingSamples) + 1;
      if (record.missingSamples >= 3) record.minMultiple = 0;
      continue;
    }
    record.missingSamples = 0;
    const currentMarketCap = num(pair.marketCap) || num(pair.fdv);
    const currentLiquidity = num(pair?.liquidity?.usd);
    if (currentMarketCap <= 0) continue;
    const multiple = currentMarketCap / num(record.entry.marketCap);
    record.minMultiple = Math.min(num(record.minMultiple) || 1, multiple);
    record.maxMultiple = Math.max(num(record.maxMultiple) || 1, multiple);
    record.last = { at: now, marketCap: currentMarketCap, liquidity: currentLiquidity, multiple };
    const age = now - num(record.entryAt);
    for (const [label, delay] of checkpoints) {
      if (age >= delay && !record.checkpoints?.[label]) {
        record.checkpoints[label] = { at: now, marketCap: currentMarketCap, liquidity: currentLiquidity, multiple };
      }
    }
    if (age >= LEARNING_WINDOW_MS) record.outcome = classifyLearningOutcome(record);
  }
  await statePut(env, JSON.stringify(records.slice(-LEARNING_RECORD_LIMIT)), "learning_records");
  return { tracked: active.length, totalRecords: records.length };
}

function classifyLearningOutcome(record) {
  const minMultiple = num(record.minMultiple);
  const maxMultiple = num(record.maxMultiple);
  const entryLiquidity = num(record.entry?.liquidity);
  const lastLiquidity = num(record.last?.liquidity);
  if (minMultiple <= 0.1 || (entryLiquidity > 0 && lastLiquidity / entryLiquidity <= 0.2)) return "rug";
  if (minMultiple <= 0.2) return "steep_drawdown";
  if (maxMultiple >= 3) return "runner_3x_plus";
  if (maxMultiple >= 1.5) return "winner_1_5x_plus";
  if (num(record.last?.multiple) >= 0.7) return "held";
  return "faded";
}

function buildLearningReport(records) {
  const outcomes = {};
  let alerted = 0;
  let rejected = 0;
  let falseNegativeRunners = 0;
  for (const record of records) {
    if (record.alerted) alerted += 1;
    else rejected += 1;
    outcomes[record.outcome || "tracking"] = num(outcomes[record.outcome || "tracking"]) + 1;
    if (!record.alerted && num(record.maxMultiple) >= 3) falseNegativeRunners += 1;
  }
  return {
    build: BUILD_ID,
    total: records.length,
    alerted,
    rejected,
    falseNegativeRunners,
    outcomes,
    recent: records.slice(-25).reverse(),
  };
}

function paperTokenKey(item) {
  // Solana contract addresses are case-sensitive.
  const chainId = item.chainId || paperChainId(item.source);
  const contract = String(item.contract || "");
  return `${chainId}:${chainId === "solana" ? contract : contract.toLowerCase()}`;
}

function firstPaperRecords(records, timeField) {
  const first = new Map();
  for (const item of records.filter((record) => record?.contract)) {
    const key = paperTokenKey(item);
    const previous = first.get(key);
    if (!previous || num(item[timeField]) < num(previous[timeField])) first.set(key, item);
  }
  return [...first.values()];
}

async function loadPaperEntryHistory(env, positions) {
  const history = parseJsonArray(await stateGet(env, "paper_entry_history"));
  return new Set([...history, ...positions.map(paperTokenKey)]);
}

async function recordPaperWatch(env, call, review) {
  const now = Date.now();
  const watch = firstPaperRecords(parseJsonArray(await stateGet(env, "paper_watch")), "alertedAt");
  const positions = firstPaperRecords(parseJsonArray(await stateGet(env, "paper_positions")), "entryAt");
  const chainId = paperChainId(call.source);
  const key = paperTokenKey({ contract: call.contract, chainId });
  const history = await loadPaperEntryHistory(env, positions);
  const existingPosition = positions.find((position) => paperTokenKey(position) === key);
  if (history.has(key)) {
    // Repeat alerts never change entry price, entry day, or exit state.
    if (existingPosition) existingPosition.lastAlertedAt = now;
    const existingWatch = watch.find((record) => paperTokenKey(record) === key);
    if (existingWatch) {
      existingWatch.lastAlertedAt = now;
      existingWatch.status = "entered";
    }
    await statePut(env, JSON.stringify([...history]), "paper_entry_history");
    await statePut(env, JSON.stringify(watch.slice(-PAPER_RECORD_LIMIT)), "paper_watch");
    await statePut(env, JSON.stringify(positions.slice(-PAPER_RECORD_LIMIT)), "paper_positions");
    return;
  }
  let item = watch.find((record) => paperTokenKey(record) === key);
  if (!item) {
    item = {
      contract: call.contract,
      name: String(call.name || "Unknown").slice(0, 80),
      source: call.source || "SEEKR",
      chainId: paperChainId(call.source),
      alertedAt: now,
      alertMarketCap: num(review.marketCap),
      lastMarketCap: num(review.marketCap),
      status: "watching",
    };
    watch.push(item);
  } else {
    item.lastMarketCap = num(review.marketCap);
    item.lastAlertedAt = now;
  }
  if (!history.has(key)) {
    const marketCap = num(review.marketCap);
    positions.push({
      id: `${call.contract}:${now}`,
      contract: call.contract,
      name: String(call.name || "Unknown").slice(0, 80),
      source: call.source || "SEEKR",
      chainId,
      alertedAt: now,
      entryAt: now,
      entryMarketCap: marketCap,
      entryLiquidity: num(review.liquidity),
      stopMarketCap: marketCap * PAPER_STOP_MULTIPLE,
      strategyVersion: PAPER_STRATEGY_VERSION,
      remainingFraction: 1,
      realizedReturnMultiple: 0,
      targetBand: marketCap >= PAPER_ENTRY_MIN_MARKET_CAP && marketCap <= PAPER_ENTRY_MAX_MARKET_CAP,
      status: "open",
      currentMarketCap: marketCap,
      currentMultiple: 1,
      minMultiple: 1,
      maxMultiple: 1,
      milestones: {},
    });
    item.status = "entered";
    item.enteredAt = now;
    item.entryMarketCap = marketCap;
  }
  history.add(key);
  await statePut(env, JSON.stringify([...history]), "paper_entry_history");
  await statePut(env, JSON.stringify(watch.slice(-PAPER_RECORD_LIMIT)), "paper_watch");
  await statePut(env, JSON.stringify(positions.slice(-PAPER_RECORD_LIMIT)), "paper_positions");
}

async function updatePaperLedgerSafe(env) {
  try {
    return await updatePaperLedger(env);
  } catch (error) {
    if (String(error).includes("429")) {
      await statePut(env, Date.now() + 15 * 60_000, "paper_next_attempt").catch(console.error);
    }
    return { error: String(error) };
  }
}

async function updatePaperLedger(env) {
  const now = Date.now();
  const nextAttempt = Number(await stateGet(env, "paper_next_attempt")) || 0;
  if (now < nextAttempt) {
    return { ...paperScanResult(parseJsonArray(await stateGet(env, "paper_positions")),
      parseJsonArray(await stateGet(env, "paper_watch"))), skipped: "Provider cooldown",
      retryAt: new Date(nextAttempt).toISOString() };
  }
  if (env._scanDeadline) await scanProgress(env, "paper-load");
  const watch = firstPaperRecords(parseJsonArray(await stateGet(env, "paper_watch")), "alertedAt");
  const positions = firstPaperRecords(parseJsonArray(await stateGet(env, "paper_positions")), "entryAt");
  const history = await loadPaperEntryHistory(env, positions);
  const watching = watch.filter((item) =>
    item?.contract && item.status === "watching" && now - num(item.alertedAt) <= PAPER_WATCH_WINDOW_MS
  );
  const open = positions.filter((item) => item?.contract && item.status === "open");
  const tracked = [...open, ...watching];
  if (env._scanDeadline) await scanProgress(env, "paper-quotes");
  const pairs = new Map();
  for (const chainId of [...new Set(tracked.map((item) => item.chainId || "solana"))]) {
    const contracts = [...new Set(tracked.filter((item) => (item.chainId || "solana") === chainId).map((item) => item.contract))];
    for (let i = 0; i < contracts.length; i += 30) {
      const batch = await getBestPairs(contracts.slice(i, i + 30), chainId, env);
      for (const [contract, pair] of batch) pairs.set(`${chainId}:${contract}`, pair);
    }
  }

  if (env._scanDeadline) await scanProgress(env, "paper-apply");
  for (const item of watching) {
    const chainId = item.chainId || "solana";
    const pair = pairs.get(`${chainId}:${String(item.contract).toLowerCase()}`);
    const marketCap = num(pair?.marketCap) || num(pair?.fdv);
    if (marketCap <= 0) continue;
    item.previousMarketCap = num(item.lastMarketCap);
    item.lastMarketCap = marketCap;
    item.lastCheckedAt = now;
    if (marketCap < PAPER_ENTRY_MIN_MARKET_CAP || marketCap > PAPER_ENTRY_MAX_MARKET_CAP) continue;
    if (history.has(paperTokenKey(item))) {
      item.status = "entered";
      continue;
    }
    const position = {
      id: `${item.contract}:${now}`,
      contract: item.contract,
      name: item.name,
      source: item.source,
      chainId,
      alertedAt: item.alertedAt,
      entryAt: now,
      entryMarketCap: marketCap,
      entryLiquidity: num(pair?.liquidity?.usd),
      stopMarketCap: marketCap * PAPER_STOP_MULTIPLE,
      strategyVersion: PAPER_STRATEGY_VERSION,
      remainingFraction: 1,
      realizedReturnMultiple: 0,
      targetBand: true,
      status: "open",
      currentMarketCap: marketCap,
      currentMultiple: 1,
      minMultiple: 1,
      maxMultiple: 1,
      milestones: {},
    };
    positions.push(position);
    history.add(paperTokenKey(position));
    item.status = "entered";
    item.enteredAt = now;
    item.entryMarketCap = marketCap;
  }

  for (const position of positions.filter((item) => item.status === "open")) {
    const chainId = position.chainId || "solana";
    const pair = pairs.get(`${chainId}:${String(position.contract).toLowerCase()}`);
    const marketCap = num(pair?.marketCap) || num(pair?.fdv);
    if (marketCap <= 0) {
      position.missingSamples = num(position.missingSamples) + 1;
      if (position.missingSamples >= 3) {
        position.status = "stopped";
        position.closedAt = now;
        position.exitMarketCap = 0;
        position.exitMultiple = 0;
        if (position.strategyVersion === PAPER_STRATEGY_VERSION) closePaperPosition(position, "missing-data", 0, now);
      }
      continue;
    }
    position.missingSamples = 0;
    const multiple = marketCap / num(position.entryMarketCap);
    position.currentMarketCap = marketCap;
    position.currentMultiple = multiple;
    position.currentLiquidity = num(pair?.liquidity?.usd);
    position.lastCheckedAt = now;
    position.minMultiple = Math.min(num(position.minMultiple) || 1, multiple);
    position.maxMultiple = Math.max(num(position.maxMultiple) || 1, multiple);
    for (const target of [1.5, 2, 3, 5, 10]) {
      const key = `x${String(target).replace(".", "_")}`;
      if (multiple >= target && !position.milestones[key]) {
        position.milestones[key] = { at: now, marketCap, multiple };
      }
    }
    if (position.strategyVersion === PAPER_STRATEGY_VERSION) {
      applyPaperExitRules(position, multiple, now);
      continue;
    }
    if (multiple <= PAPER_STOP_MULTIPLE) {
      position.status = "stopped";
      position.closedAt = now;
      position.exitMarketCap = marketCap;
      position.exitMultiple = multiple;
    } else if (now - num(position.entryAt) > PAPER_POSITION_WINDOW_MS) {
      position.status = "expired";
      position.closedAt = now;
      position.exitMarketCap = marketCap;
      position.exitMultiple = multiple;
    }
  }

  for (const item of watch) {
    if (item.status === "watching" && now - num(item.alertedAt) > PAPER_WATCH_WINDOW_MS) item.status = "expired";
  }
  if (env._scanDeadline) await scanProgress(env, "paper-save");
  await statePut(env, now + 9 * 60_000, "paper_next_attempt");
  await statePut(env, JSON.stringify([...history]), "paper_entry_history");
  const savedPositions = positions.slice(-PAPER_RECORD_LIMIT);
  const savedWatch = watch.slice(-PAPER_RECORD_LIMIT);
  await statePut(env, JSON.stringify(savedPositions), "paper_positions");
  await statePut(env, JSON.stringify(savedWatch), "paper_watch");
  return paperScanResult(savedPositions, savedWatch);
}

function closePaperPosition(position, reason, multiple, now) {
  position.realizedReturnMultiple = num(position.realizedReturnMultiple) + num(position.remainingFraction) * multiple;
  position.remainingFraction = 0;
  position.status = reason === "trailing-stop" ? "trailed" : reason === "time-limit" ? "expired" : reason === "missing-data" ? "unpriced" : "stopped";
  position.exitReason = reason;
  position.closedAt = now;
  position.exitMultiple = multiple;
  position.exitMarketCap = num(position.entryMarketCap) * multiple;
  position.totalReturnMultiple = position.realizedReturnMultiple;
  position.pnlPct = (position.totalReturnMultiple - 1) * 100;
}

function applyPaperExitRules(position, multiple, now) {
  // Use observed samples as fills; do not invent fills at crossed thresholds.
  if (!position.partialSale && multiple <= PAPER_STOP_MULTIPLE) {
    closePaperPosition(position, "initial-stop", multiple, now);
    return;
  }
  if (!position.partialSale && multiple >= PAPER_TAKE_PROFIT_MULTIPLE) {
    position.partialSale = { at: now, multiple, fraction: 0.5 };
    position.realizedReturnMultiple = 0.5 * multiple;
    position.remainingFraction = 0.5;
    position.runnerPeakMultiple = multiple;
  }
  if (position.partialSale) {
    position.runnerPeakMultiple = Math.max(num(position.runnerPeakMultiple), multiple);
    position.trailingStopMultiple = position.runnerPeakMultiple * (1 - PAPER_TRAIL_FRACTION);
    position.trailingStopMarketCap = num(position.entryMarketCap) * position.trailingStopMultiple;
    if (multiple <= position.trailingStopMultiple) {
      closePaperPosition(position, "trailing-stop", multiple, now);
      return;
    }
  }
  if (now - num(position.entryAt) > PAPER_POSITION_WINDOW_MS) {
    closePaperPosition(position, "time-limit", multiple, now);
  }
}

const PAPER_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});

function paperPacificDate(timestamp) {
  return PAPER_DATE_FORMATTER.format(new Date(timestamp));
}

function paperScanResult(positions, watch) {
  // Report generation is only needed for the scheduled evening delivery.
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23",
  }).formatToParts(new Date()).find((part) => part.type === "hour")?.value || 0);
  if (hour >= 20) return buildPaperReport(positions, watch);
  return { updated: true, trackedPositions: positions.length, watchedCalls: watch.length };
}

function buildPaperReport(positions, watch, entryDate = null, dateCache = new Map()) {
  const dateFor = (timestamp) => {
    if (!dateCache.has(timestamp)) dateCache.set(timestamp, paperPacificDate(timestamp));
    return dateCache.get(timestamp);
  };
  positions = firstPaperRecords(positions, "entryAt");
  watch = firstPaperRecords(watch, "alertedAt");
  const allPositions = positions;
  const allWatch = watch;
  if (entryDate) {
    positions = positions.filter((item) => dateFor(num(item.entryAt)) === entryDate);
    watch = watch.filter((item) => dateFor(num(item.alertedAt)) === entryDate);
  }
  const strategyPositions = positions.filter((item) => item.strategyVersion === PAPER_STRATEGY_VERSION);
  const strategyClosed = strategyPositions.filter((item) => item.status !== "open");
  const realized = strategyPositions.reduce((sum, item) => sum + num(item.realizedReturnMultiple), 0);
  const remaining = strategyPositions.filter((item) => item.status === "open")
    .reduce((sum, item) => sum + num(item.remainingFraction) * num(item.currentMultiple), 0);
  const open = positions.filter((item) => item.status === "open");
  const stopped = positions.filter((item) => item.status === "stopped");
  const hit2x = positions.filter((item) => num(item.maxMultiple) >= 2);
  const hit3x = positions.filter((item) => num(item.maxMultiple) >= 3);
  const stoppedBefore2x = stopped.filter((item) => num(item.maxMultiple) < 2);
  const targetBand = positions.filter((item) => item.targetBand === true);
  const outsideBand = positions.filter((item) => item.targetBand !== true);
  const cohort = (items) => ({
    entries: items.length,
    open: items.filter((item) => item.status === "open").length,
    stopped: items.filter((item) => item.status === "stopped").length,
    hit2x: items.filter((item) => num(item.maxMultiple) >= 2).length,
    hit3x: items.filter((item) => num(item.maxMultiple) >= 3).length,
  });
  return {
    build: BUILD_ID,
    openRunners: allPositions.filter((item) => item.status === "open" &&
      (item.partialSale || num(item.maxMultiple) >= 2))
      .sort((a, b) => num(b.currentMultiple) - num(a.currentMultiple)),
    scope: entryDate ? "Entries opened on this Pacific date" : "Cumulative retained entries",
    entryDate,
    ...(entryDate ? {} : {
      daily: buildPaperReport(allPositions, allWatch, dateFor(Date.now()), dateCache),
      days: [...new Set(allPositions.map((item) => dateFor(num(item.entryAt))))]
        .sort().reverse().map((date) => {
          const day = buildPaperReport(allPositions, allWatch, date, dateCache);
          return { date, totals: day.totals, strategy: day.strategy, cohorts: day.cohorts };
        }),
    }),
    rules: {
      entryMarketCap: `$${PAPER_ENTRY_MIN_MARKET_CAP.toLocaleString("en-US")}-$${PAPER_ENTRY_MAX_MARKET_CAP.toLocaleString("en-US")}`,
      stop: "-60%",
      takeProfit: "Sell half at first observed 2x or higher",
      runnerTrail: "-35% from highest observed price after half-sale",
      strategyVersion: PAPER_STRATEGY_VERSION,
      execution: "Sampled market-cap proxy; excludes fees and slippage; missing quotes are marked unpriced",
      legacyEntries: "Keep original exit rules",
      milestones: ["1.5x", "2x", "3x", "5x", "10x"],
      watchHoursAfterAlert: PAPER_WATCH_WINDOW_MS / 3_600_000,
    },
    totals: {
      watchedCalls: watch.length,
      entries: positions.length,
      open: open.length,
      stopped: stopped.length,
      stoppedBefore2x: stoppedBefore2x.length,
      hit2x: hit2x.length,
      hit3x: hit3x.length,
    },
    strategy: {
      entries: strategyPositions.length,
      legacyEntries: positions.length - strategyPositions.length,
      halfSold: strategyPositions.filter((item) => item.partialSale).length,
      trailed: strategyPositions.filter((item) => item.status === "trailed").length,
      unpriced: strategyPositions.filter((item) => item.status === "unpriced").length,
      closed: strategyClosed.length,
      realizedReturnUnits: realized,
      remainingValueUnits: remaining,
      closedPnlUnits: strategyClosed.reduce((sum, item) => sum + num(item.totalReturnMultiple) - 1, 0),
      netPnlUnits: realized + remaining - strategyPositions.length,
      unitBasis: "Equal initial stake per entry; missing quotes value remaining stake at zero",
    },
    cohorts: {
      target150kTo180k: cohort(targetBand),
      allOtherEntries: cohort(outsideBand),
    },
    positions: [...positions].reverse(),
  };
}

function paperChainId(source) {
  if (source === "BNB") return BNB_CHAIN_ID;
  if (source === "ROBINHOOD") return ROBINHOOD_CHAIN_ID;
  return "solana";
}

function isOpenPaperRunner(item) {
  return item.status === "open" && Boolean(item.partialSale || num(item.maxMultiple) >= 2);
}

function paperProfitDetail(item) {
  const modern = item.strategyVersion === PAPER_STRATEGY_VERSION;
  const open = item.status === "open";
  const remaining = open ? (modern ? num(item.remainingFraction) : 1) : 0;
  const proceeds = modern ? num(item.realizedReturnMultiple) : (open ? 0 : num(item.exitMultiple));
  const total = proceeds + remaining * num(item.currentMultiple);
  const bookedProfit = proceeds - (1 - remaining);
  const signed = (value) => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
  return `Paper P&amp;L: ${signed((total - 1) * 100)}% (${signed((total - 1) * 100)} dollars per $100 entry)\nBooked P&amp;L: ${signed(bookedProfit * 100)} dollars per $100 | Remaining: ${(remaining * 100).toFixed(0)}%${item.status === "unpriced" ? "\nUnpriced exit: remaining stake valued at zero; result is an estimate." : ""}`;
}

function formatPaperCoinBlock(item) {
  const chain = item.chainId || "solana";
  const link = `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(item.contract)}`;
  const peak = num(item.maxMultiple);
  const milestones = [2, 3, 5, 10].filter((target) => peak >= target).map((target) => `${target}×`);
  const open = item.status === "open";
  const marketCap = open ? num(item.currentMarketCap) : num(item.exitMarketCap);
  const multiple = open ? num(item.currentMultiple) : num(item.exitMultiple);
  const lines = [
    `<b>${esc(item.name || "Unknown")}</b> — ${esc(item.status)}`,
    `Initial mcap: ${usd(num(item.entryMarketCap))} | Entry day: ${paperPacificDate(num(item.entryAt))}`,
    `${open ? "Latest" : "Exit"} mcap: ${usd(marketCap)} (${multiple.toFixed(2)}×) | Observed peak: ${peak.toFixed(2)}×`,
    `Reached: ${milestones.length ? milestones.join(", ") : "Below 2×"}`,
    paperProfitDetail(item),
  ];
  if (item.partialSale) lines.push(`Half sold at ${num(item.partialSale.multiple).toFixed(2)}×`);
  if (open && item.partialSale) lines.push(`35% trail trigger: ${usd(num(item.trailingStopMarketCap))} (${num(item.trailingStopMultiple).toFixed(2)}×)`);
  if (item.exitReason) lines.push(`Exit reason: ${esc(item.exitReason)}`);
  if (item.strategyVersion !== PAPER_STRATEGY_VERSION) lines.push("Legacy paper exit rules");
  if (open) lines.push(`Last sample: ${item.lastCheckedAt ? new Date(item.lastCheckedAt).toISOString() : "pending"}${num(item.missingSamples) > 0 ? " — quote missing; latest value is stale" : ""}`);
  lines.push(`CA: <a href="${link}">${esc(item.contract)}</a>`);
  return lines.join("\n");
}

function formatPaperCoinMessages(items, heading, emptyText) {
  if (!items.length) return [heading + "\n" + emptyText];
  const messages = [];
  let message = heading;
  for (const item of items) {
    const block = formatPaperCoinBlock(item);
    if (message.length + block.length + 2 > 3500) {
      messages.push(message);
      message = heading;
    }
    message += "\n" + block + "\n";
  }
  messages.push(message);
  return messages;
}

function formatOpenRunnerMessages(runners, date) {
  return formatPaperCoinMessages(runners,
    `🏃 <b>RUNNER LIST — ${esc(date)} (Pacific)</b>\nAll entry days; reached 2× and still open.\nP&amp;L uses a hypothetical $100 initial stake; includes remaining open value.\n`,
    "No open runners currently tracked.");
}

function formatDailyPaperCoinMessages(positions, date) {
  return formatPaperCoinMessages(positions.filter((item) => !isOpenPaperRunner(item)),
    `📋 <b>COIN RESULTS — ${esc(date)} (Pacific)</b>\nToday's entries; open runners appear separately on the runner list.\nP&amp;L uses a hypothetical $100 initial stake; includes remaining open value.\n`,
    "No other entries today; see the runner list for any open runners.");
}

async function maybeSendDailyPaperReport(env, report) {
  if (!report?.totals) return;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  if (Number(value("hour")) * 60 + Number(value("minute")) < 20 * 60 + 30) return;
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  if ((await stateGet(env, "paper_daily_report_date")) === date) return;
  const openRunners = report.openRunners || [];
  report = report.daily || report;
  const t = report.totals;
  const band = report.cohorts?.target150kTo180k || {};
  await sendTelegram(env, [
    `📊 <b>DAILY PAPER LEDGER — ${esc(date)} (Pacific)</b>`,
    "Entries opened today only; earlier days are separate.",
    `All entries: <b>${t.entries}</b> | Open: <b>${t.open}</b>`,
    `Hit 2×: <b>${t.hit2x}</b> | Hit 3×: <b>${t.hit3x}</b>`,
    `Initial-stop exits (sampled): <b>${t.stopped}</b>`,
    `Stopped before 2×: <b>${t.stoppedBefore2x}</b>`,
    `$150K–$180K group: <b>${band.entries || 0}</b> entries, <b>${band.hit2x || 0}</b> hit 2×, <b>${band.stopped || 0}</b> stopped`,
    `New strategy entries: <b>${report.strategy?.entries || 0}</b> | Legacy: <b>${report.strategy?.legacyEntries || 0}</b>`,
    `Half sold at 2×+: <b>${report.strategy?.halfSold || 0}</b> | 35% trail exits: <b>${report.strategy?.trailed || 0}</b>`,
    `New strategy P&amp;L (equal stakes): <b>${num(report.strategy?.netPnlUnits).toFixed(2)} units</b> (includes open value)`,
    `Closed P&amp;L: <b>${num(report.strategy?.closedPnlUnits).toFixed(2)} units</b> | Unpriced exits: <b>${report.strategy?.unpriced || 0}</b>`,
    "Sampled market-cap estimates; fees/slippage excluded. Missing quotes valued at zero.",
    "Paper tracking only—no automatic buying or selling.",
  ].join("\n"));
  for (const message of formatDailyPaperCoinMessages(report.positions || [], date)) {
    await sendTelegram(env, message);
  }
  for (const message of formatOpenRunnerMessages(openRunners, date)) {
    await sendTelegram(env, message);
  }
  await statePut(env, date, "paper_daily_report_date");
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

async function getBestPair(contract, dexId = null, chainId = "solana", env, forceFresh = false) {
  const key = chainId + ":" + contract;
  let data = !forceFresh && env?._dex?.cache.get(key);
  if (data) env._dex.cacheHits += 1;
  else {
    data = await dexJson(env, `https://api.dexscreener.com/token-pairs/v1/${chainId}/${contract}`);
    env?._dex?.cache.set(key, data);
  }
  return selectBestPair(data, contract, dexId, chainId);
}

function selectBestPair(data, contract, dexId = null, chainId = "solana") {
  let pairs = (Array.isArray(data) ? data : []).filter((p) =>
    p.chainId === chainId && (!dexId || String(p.dexId).toLowerCase().includes(dexId))
  );
  if (chainId === "solana") {
    // DexScreener can return the candidate as either side of a pool. The scoring
    // fields describe the base token, so accepting a candidate on the quote side
    // can score the wrong asset. Also reject pools quoted in another unproven token.
    pairs = pairs.filter((p) =>
      String(p?.baseToken?.address || "") === contract &&
      TRUSTED_SOLANA_QUOTES.has(String(p?.quoteToken?.address || ""))
    );

    // Conflicting prices across meaningful, actively traded pools are a common
    // migration/rug warning. Fail closed instead of trusting the largest pool.
    const activePrices = pairs
      .filter((p) =>
        num(p?.liquidity?.usd) >= MIN_POOL_INTEGRITY_LIQUIDITY &&
        num(p?.txns?.h1?.buys) + num(p?.txns?.h1?.sells) >= MIN_POOL_INTEGRITY_TRADES_H1
      )
      .map((p) => num(p?.priceUsd))
      .filter((price) => price > 0);
    if (activePrices.length > 1) {
      const spread = Math.max(...activePrices) / Math.min(...activePrices);
      if (spread > MAX_ACTIVE_POOL_PRICE_SPREAD) return null;
    }
  }
  return pairs.sort((a, b) => num(b.liquidity?.usd) - num(a.liquidity?.usd))[0] || null;
}

async function getBestPairs(contracts, chainId, env) {
  const best = new Map();
  const addresses = [...new Set(contracts)];
  const missing = addresses.filter((address) => !env?._dex?.cache.has(chainId + ":" + address));
  const local = new Map();
  for (let i = 0; i < missing.length; i += 30) {
    const batch = missing.slice(i, i + 30);
    const pairs = await dexJson(env, `https://api.dexscreener.com/tokens/v1/${chainId}/${batch.join(",")}`);
    for (const address of batch) {
      const data = (Array.isArray(pairs) ? pairs : []).filter((pair) => pair.chainId === chainId && pair.baseToken?.address === address);
      local.set(address, data);
      env?._dex?.cache.set(chainId + ":" + address, data);
    }
  }
  for (const address of addresses) {
    const data = local.get(address) || env?._dex?.cache.get(chainId + ":" + address) || [];
    if (!local.has(address) && env?._dex) env._dex.cacheHits += 1;
    const pair = selectBestPair(data, address, null, chainId);
    if (pair) best.set(address.toLowerCase(), pair);
  }
  return best;
}

async function dexJson(env, url, options = {}) {
  if (!env?.STATE) throw new Error("DexScreener request governor requires STATE");
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  for (;;) {
    if (!scanHasTime(env)) throw new Error("Scan time budget exhausted; queued work retained");
    const permit = await stub.fetch("https://state/dex-permit", {
      method: "POST", body: JSON.stringify({ priority: env._dex?.priority || "discovery" })
    }).then((r) => r.json());
    if (permit.allowed) break;
    if (permit.waitMs) { await new Promise((resolve) => setTimeout(resolve, Math.min(permit.waitMs, 1_000))); continue; }
    if (env._dex) { env._dex.throttled += 1; env._dex.retryAt = new Date(permit.retryAt).toISOString(); }
    throw new Error(permit.reason + " until " + new Date(permit.retryAt).toISOString());
  }
  if (env._dex) env._dex.requests += 1;
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const seconds = Number(header);
    const retryAfterMs = header && Number.isFinite(seconds) ? seconds * 1_000 : Math.max(0, Date.parse(header) - Date.now()) || 0;
    const backoff = await stub.fetch("https://state/dex-backoff", {
      method: "POST", body: JSON.stringify({ retryAfterMs })
    }).then((r) => r.json());
    if (env._dex) { env._dex.throttled += 1; env._dex.retryAt = new Date(backoff.retryAt).toISOString(); }
    throw new Error("api.dexscreener.com HTTP 429; shared cooldown until " + new Date(backoff.retryAt).toISOString());
  }
  if (response.ok) {
    await stub.fetch("https://state/dex-success", { method: "POST", signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(() => {});
  }
  return check(response).then((r) => r.json());
}

async function getSolanaSafety(contract, env) {
  const now = Date.now();
  const key = "safety_" + contract;
  if (env) {
    const cached = JSON.parse((await stateGet(env, key)) || "null");
    if (cached && cached.until > now) return cached.result;
    const retryAt = Number(await stateGet(env, "rugcheck_retry_at")) || 0;
    if (now < retryAt) return { passed: false, summary: "blocked: safety report unavailable (Rugcheck provider cooldown until " + new Date(retryAt).toISOString() + ")" };
  }
  try {
    const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${contract}/report`, {
      headers: { "User-Agent": "SeekrSafetyGate/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await check(response).then((r) => r.json());
    const result = reviewSolanaSafety(data);
    if (env) await statePut(env, JSON.stringify({ until: now + 60_000, result }), key);
    return result;
  } catch (error) {
    if (env && String(error).includes("429")) {
      await statePut(env, Date.now() + 3 * 60_000, "rugcheck_retry_at");
    }
    // Fail closed: an unavailable safety report must never become an alert.
    return { passed: false, summary: `blocked: safety report unavailable (Rugcheck: ${String(error)})` };
  }
}

function reviewSolanaSafety(data) {
  if (!data) return { passed: false, summary: "blocked: Rugcheck data unavailable" };

  const blockers = [];
  const mintAuthority = data.mintAuthority ?? data.token?.mintAuthority;
  const freezeAuthority = data.freezeAuthority ?? data.token?.freezeAuthority;
  const transferFeePct = num(data.transferFee?.pct);
  const rugScore = num(data.score_normalised);
  const allHolders = Array.isArray(data.topHolders) ? data.topHolders : [];
  const holders = allHolders.slice(0, 10);
  const topHolderPct = holders.length ? Math.max(...holders.map((h) => num(h?.pct))) : 0;
  const top10Pct = holders.reduce((sum, h) => sum + num(h?.pct), 0);
  const insiderPct = holders.filter((h) => h?.insider).reduce((sum, h) => sum + num(h?.pct), 0);
  const creator = String(data.creator || "").toLowerCase();
  const creatorPct = creator
    ? allHolders.filter((h) => String(h?.owner || h?.address || "").toLowerCase() === creator)
      .reduce((sum, h) => sum + num(h?.pct), 0)
    : num(data.creatorBalancePct);
  const knownAccounts = data.knownAccounts && typeof data.knownAccounts === "object" ? data.knownAccounts : {};
  const suspiciousHolders = holders.filter((holder) => {
    if (holder?.insider === true) return true;
    const address = String(holder?.owner || holder?.address || "");
    const label = `${holder?.name || ""} ${holder?.label || ""} ${knownAccounts[address]?.name || ""} ${knownAccounts[address]?.type || ""}`;
    return /bundle|bundler|snip|insider/i.test(label);
  });
  const markets = Array.isArray(data.markets) ? data.markets : [];
  const lpMarkets = markets.map((market) => market?.lp).filter(Boolean);
  const bestLp = lpMarkets.sort((a, b) => num(b?.lpLockedUSD) - num(a?.lpLockedUSD))[0] || null;
  const lpLockedPct = num(bestLp?.lpLockedPct);
  const lpLockedUsd = num(bestLp?.lpLockedUSD);
  const materialUnlockedPools = lpMarkets.filter((lp) => {
    if (lp === bestLp || num(lp?.lpLockedPct) >= MIN_LP_LOCKED_PCT) return false;
    const poolUsd = num(lp?.baseUSD) + num(lp?.quoteUSD);
    return poolUsd >= MIN_MATERIAL_UNLOCKED_POOL_USD &&
      poolUsd >= lpLockedUsd * MIN_MATERIAL_UNLOCKED_POOL_RATIO;
  });
  const copycatRisks = (Array.isArray(data.risks) ? data.risks : [])
    .filter((risk) => /copycat|impersonat|fake token|verified token/i.test(`${risk?.name || ""} ${risk?.description || ""}`))
    .map((risk) => risk?.name || risk?.description || "copycat/impersonation warning");
  const risks = Array.isArray(data.risks) ? data.risks : [];
  const riskText = (risk) => `${risk?.name || ""} ${risk?.description || ""}`;
  const priorRugRisks = risks
    .filter((risk) => /creator|developer|deployer/i.test(riskText(risk)) && /rug|scam|honeypot/i.test(riskText(risk)))
    .map((risk) => risk?.name || risk?.description || "creator linked to prior rug");
  const repeatCreatorRisks = risks
    .filter((risk) => /creator|developer|deployer/i.test(riskText(risk)) && /created|launched|deployed|previous|tokens?|coins?/i.test(riskText(risk)) && !/rug|scam|honeypot/i.test(riskText(risk)))
    .map((risk) => risk?.name || risk?.description || "repeat creator/deployer");
  const dangerousRisks = risks
    .filter((risk) => String(risk?.level || "").toLowerCase() === "danger")
    .filter((risk) => !repeatCreatorRisks.includes(risk?.name || risk?.description || "repeat creator/deployer"))
    .filter((risk) => !priorRugRisks.includes(risk?.name || risk?.description || "creator linked to prior rug"))
    .map((risk) => risk?.name || risk?.description || "dangerous Rugcheck flag");
  const bundleRisks = risks
    .filter((risk) => /bundle|bundler|snip|insider/i.test(riskText(risk)))
    .map((risk) => risk?.name || risk?.description || "bundled/sniper activity");

  if (data.rugged === true) blockers.push("Rugcheck rugged flag");
  if (!holders.length) blockers.push("holder data unavailable");
  if (!bestLp) blockers.push("LP lock/burn data unavailable");
  else {
    if (lpLockedPct < MIN_LP_LOCKED_PCT) blockers.push(`only ${lpLockedPct.toFixed(1)}% of LP locked/burned`);
    if (lpLockedUsd < MIN_LP_LOCKED_USD) blockers.push(`only $${Math.round(lpLockedUsd).toLocaleString("en-US")} locked liquidity`);
  }
  if (mintAuthority) blockers.push("mint authority enabled");
  if (freezeAuthority) blockers.push("freeze authority enabled");
  if (transferFeePct > MAX_TRANSFER_FEE_PCT) blockers.push(`transfer fee ${transferFeePct.toFixed(1)}%`);
  if (rugScore > MAX_RUGCHECK_SCORE) blockers.push(`Rugcheck risk score ${rugScore.toFixed(0)}`);
  if (topHolderPct > MAX_SINGLE_HOLDER_PCT) blockers.push(`largest holder ${topHolderPct.toFixed(1)}%`);
  if (top10Pct > MAX_TOP_10_HOLDERS_PCT) blockers.push(`top 10 hold ${top10Pct.toFixed(1)}%`);
  if (insiderPct > MAX_INSIDER_HOLDINGS_PCT) blockers.push(`known insiders hold ${insiderPct.toFixed(1)}%`);
  if (creatorPct > MAX_CREATOR_HOLDINGS_PCT) blockers.push(`creator/developer holds ${creatorPct.toFixed(1)}%`);
  if (suspiciousHolders.length > MAX_SUSPICIOUS_HOLDERS) blockers.push(`${suspiciousHolders.length} suspicious bundled/sniper/insider top holder(s)`);
  // Secondary unlocked pools are common after migrations. Surface them as a
  // prominent warning, but do not reject an otherwise safe candidate solely for this.
  const secondaryPoolWarnings = materialUnlockedPools.length
    ? [`${materialUnlockedPools.length} material unlocked secondary pool(s)`]
    : [];
  blockers.push(...priorRugRisks.slice(0, 3));
  blockers.push(...dangerousRisks.slice(0, 3));
  blockers.push(...bundleRisks.slice(0, 3));

  const details = `Rugcheck ${rugScore.toFixed(0)}; LP locked/burned ${lpLockedPct.toFixed(1)}%; creator ${creatorPct.toFixed(1)}%; top holder ${topHolderPct.toFixed(1)}%; top 10 ${top10Pct.toFixed(1)}%`;
  const warnings = [...copycatRisks, ...repeatCreatorRisks, ...secondaryPoolWarnings];
  const warning = warnings.length ? `; WARNING: ${warnings.slice(0, 3).join(", ")}` : "";
  const scorePenalty = repeatCreatorRisks.length ? 1 : 0;
  return {
    passed: blockers.length === 0,
    summary: blockers.length ? `blocked: ${blockers.join(", ")}${warning}` : `passed; ${details}${warning}`,
    rugScore,
    topHolderPct,
    top10Pct,
    insiderPct,
    creatorPct,
    lpLockedPct,
    lpLockedUsd,
    materialUnlockedPoolCount: materialUnlockedPools.length,
    copycatRiskCount: copycatRisks.length,
    suspiciousHolderCount: suspiciousHolders.length,
    repeatCreatorRiskCount: repeatCreatorRisks.length,
    priorRugRiskCount: priorRugRisks.length,
    scorePenalty,
  };
}

function passesMarketSafety(review) {
  if (!review || !Number.isFinite(review.marketCap) || review.marketCap <= 0) return false;
  if (review.liquidity < MIN_LIQUIDITY) return false;
  if (review.liquidity / review.marketCap < MIN_LIQUIDITY_TO_MARKET_CAP) return false;
  if (review.changeM5 < MAX_5M_DROP_PCT || review.changeH1 < MAX_1H_DROP_PCT) return false;
  if (review.sells > 0 && review.buys / review.sells < MIN_BUY_SELL_RATIO) return false;
  return true;
}

async function confirmMarketMomentum(call, initialPair, options = {}) {
  const shared = options.env?._dex;
  // Share the complete two-observation check, never just the refreshed price:
  // using that price as both observations would silently weaken confirmation.
  const key = JSON.stringify([options.chainId || "solana", call.contract,
    options.dexId || null, initialPair?.pairAddress || null]);
  if (!shared) return performMarketConfirmation(call, initialPair, options);
  shared.confirmations ||= new Map();
  let confirmation = shared.confirmations.get(key);
  if (confirmation) shared.sharedConfirmations = num(shared.sharedConfirmations) + 1;
  else {
    confirmation = performMarketConfirmation(call, initialPair, options);
    shared.confirmations.set(key, confirmation);
  }
  // Keep failures shared too: another source must not retry the same failed
  // request during this scan. Each scan starts with a new confirmation map.
  const result = await confirmation;
  return { ...result, review: scorePair(call, result.pair, options.chainName || "Solana") };
}

async function performMarketConfirmation(call, initialPair, options = {}) {
  const chainId = options.chainId || "solana";
  const chainName = options.chainName || "Solana";
  const initialReview = scorePair(call, initialPair, chainName);
  if (!passesMarketSafety(initialReview)) {
    return { passed: false, pair: initialPair, review: initialReview, initialReview, summary: "blocked by initial momentum gate" };
  }

  // A candidate must remain healthy across two observations before Telegram receives it.
  await new Promise((resolve) => setTimeout(resolve, FINAL_CONFIRM_DELAY_MS));
  const freshPair = await getBestPair(call.contract, options.dexId || null, chainId, options.env, true);
  const freshReview = scorePair(call, freshPair, chainName);
  if (!passesMarketSafety(freshReview)) {
    return { passed: false, pair: freshPair, review: freshReview, initialReview, summary: "blocked by final momentum gate" };
  }

  // Never confirm a token by silently switching to a different pool. A pool
  // migration, spoof pool, or fragmented launch must be reviewed separately.
  const initialPool = String(initialPair?.pairAddress || "").toLowerCase();
  const freshPool = String(freshPair?.pairAddress || "").toLowerCase();
  if (!initialPool || initialPool !== freshPool) {
    return { passed: false, pair: freshPair, review: freshReview, initialReview, summary: "blocked: selected pool changed during confirmation" };
  }

  const initialPrice = num(initialPair?.priceUsd);
  const freshPrice = num(freshPair?.priceUsd);
  const priceDropPct = initialPrice > 0 ? ((initialPrice - freshPrice) / initialPrice) * 100 : 0;
  const liquidityDropPct = initialReview.liquidity > 0
    ? ((initialReview.liquidity - freshReview.liquidity) / initialReview.liquidity) * 100
    : 0;
  if (priceDropPct > MAX_CONFIRM_PRICE_DROP_PCT || liquidityDropPct > MAX_CONFIRM_LIQUIDITY_DROP_PCT) {
    return { passed: false, pair: freshPair, review: freshReview, initialReview, priceDropPct, liquidityDropPct, summary: "blocked: price or liquidity deteriorated during confirmation" };
  }

  return { passed: true, pair: freshPair, review: freshReview, initialReview, priceDropPct, liquidityDropPct, summary: "passed two-observation momentum confirmation" };
}

function scorePair(call, pair, chainName = "Solana") {
  if (!pair) return { score: 0, marketCap: Infinity, reasons: [`No ${chainName} pool indexed yet`] };
  const marketCap = num(pair.marketCap || pair.fdv);
  const liquidity = num(pair.liquidity?.usd);
  const volumeH1 = num(pair.volume?.h1);
  const changeM5 = num(pair.priceChange?.m5);
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
  return { score, marketCap, liquidity, volumeH1, changeM5, changeH1, buys, sells, ageMinutes, reasons };
}

function formatAlert(call, pair, r) {
  const chainPath = call.source === "ROBINHOOD" ? "robinhood" : call.source === "BNB" ? "bsc" : "solana";
  const link = pair?.url || `https://dexscreener.com/${chainPath}/${call.contract}`;

  const source = call.source === "RAYDIUM" ? "RAYDIUM" : call.source === "PUMPSWAP" ? "PUMPSWAP RESURGENCE" : call.source === "ROBINHOOD" ? "ROBINHOOD CHAIN" : call.source === "BNB" ? "BNB CHAIN" : "SEEKR";
  const first = r.confirmation?.initialReview;
  const poolAddress = String(pair?.pairAddress || "unknown");
  const poolLabel = poolAddress === "unknown" ? poolAddress : `${poolAddress.slice(0, 6)}…${poolAddress.slice(-6)}`;
  const lines = [
    `🚨 <b>${source} CANDIDATE — ${esc(call.name)}</b>`,
    `Build: <code>${BUILD_ID}</code>`,
    `Pool: ${esc(String(pair?.dexId || "unknown"))} / <code>${esc(poolLabel)}</code>`,
    `Score: <b>${r.score}/9</b>`,
    `Market cap: <b>${usd(r.marketCap)}</b>`,
    `Entry tier: <b>${marketCapTier(r.marketCap)}</b>`,
    `Liquidity: ${usd(r.liquidity)}`,
    `1h volume: ${usd(r.volumeH1)}`,
    `1h change: ${r.changeH1.toFixed(1)}%`,
    `1h buys/sells: ${r.buys}/${r.sells}`,
    `Why: ${esc(r.reasons.join(", "))}`,
  ];
  if (first) {
    lines.push(
      `20s recheck: market cap ${usd(num(first.marketCap))} → ${usd(r.marketCap)}; liquidity ${usd(num(first.liquidity))} → ${usd(r.liquidity)}`,
      `Recheck result: ${esc(r.confirmation.summary)}`,
    );
  }
  if (r.safety) lines.push(`Safety: ${esc(r.safety.summary)}`);
  lines.push(`CA: <a href="${link}">${call.contract}</a>`, "⚠️ Preliminary alert only—verify holders, insiders, bundlers and socials before risking money.");
  return lines.join("\n");
}

async function sendTelegram(env, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  await check(response);
  const receipt = await response.json();
  if (!receipt.ok) throw new Error("Telegram delivery failed: " + (receipt.description || "unknown error"));
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
function marketCapTier(value) {
  const marketCap = num(value);
  if (marketCap < 500_000) return "EARLY — highest risk / highest upside";
  if (marketCap < 1_000_000) return "BUILDING — confirmed momentum";
  if (marketCap <= 2_000_000) return "ESTABLISHED MOMENTUM — lower multiple potential";
  return "LATE — above PumpSwap resurgence range";
}
function usd(value) { return Number.isFinite(value) ? `$${Math.round(value).toLocaleString("en-US")}` : "n/a"; }
function esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function parseJsonArray(value) { try { const v = JSON.parse(value || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
async function check(response) { if (!response.ok) throw new Error(`${response.url ? new URL(response.url).hostname : "unknown provider"} HTTP ${response.status}`); return response; }
