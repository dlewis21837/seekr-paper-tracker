const CHANNEL = "SeekrTrending";
const BUILD_ID = "raydium-trending-v11-2026-09-25";
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await scan(env);
      return Response.json(result);
    }
    if (url.pathname === "/learning") {
      const records = parseJsonArray(await stateGet(env, "learning_records"));
      return Response.json(buildLearningReport(records));
    }
    return Response.json({
      status: "Seekr + Raydium + PumpSwap + Meteora momentum + Robinhood Chain + BNB Chain tracker online",
      build: BUILD_ID,
      schedule: "Every 3 minutes, 5:00 a.m.–8:00 p.m. Pacific",
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.STATE),
      robinhoodConfigured: Boolean(env.BITQUERY_TOKEN),
      bnbConfigured: Boolean(env.BITQUERY_TOKEN),
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
  return stub.fetch(`https://state/get?key=${encodeURIComponent(key)}`).then((r) => r.text());
}

async function statePut(env, value, key = "last_message_id") {
  const stub = env.STATE.get(env.STATE.idFromName("seekr"));
  await stub.fetch(`https://state/put?key=${encodeURIComponent(key)}`, { method: "POST", body: String(value) });
}

async function scan(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.STATE) {
    return { ok: false, error: "Missing Telegram secrets or STATE binding" };
  }
  if (!insidePacificWindow()) {
    const learning = await updateLearningOutcomes(env).catch((error) => ({ error: String(error) }));
    return { ok: true, skipped: "Outside active hours", learning };
  }

  const html = await fetch(`https://t.me/s/${CHANNEL}`, {
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
  const results = [];
  for (const call of fresh) {
    try {
      const pair = await getBestPair(call.contract);
      const confirmation = await confirmMarketMomentum(call, pair);
      const review = confirmation.review;
      const safety = await getSolanaSafety(call.contract);
      const effectiveScore = review.score - num(safety.scorePenalty);
      const alerted = safety.passed && confirmation.passed && effectiveScore >= MIN_SCORE && review.marketCap <= MAX_MARKET_CAP;
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

  if (newestId > lastId) await statePut(env, newestId);
  const solanaMomentum = await scanSolanaMomentum(env);
  const robinhood = await scanRobinhood(env);
  const bnb = await scanBnb(env);
  const learning = await updateLearningOutcomes(env).catch((error) => ({ error: String(error) }));
  if (connected) {
    await sendTelegram(env, `✅ Seekr + Raydium + PumpSwap + Meteora momentum + Robinhood Chain + BNB Chain tracker connected. Build: <code>${BUILD_ID}</code>. Scanning every 3 minutes from 5:00 a.m. to 8:00 p.m. Pacific.`);
  }
  return { ok: true, build: BUILD_ID, seekrChecked: fresh.length, seekrResults: results, ...solanaMomentum, robinhood, bnb, learning };
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 1_000 * (2 ** attempt);
      lastError = new Error(`HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Request failed");
}

async function getSolanaMomentumPayloads() {
  try {
    const payload = await fetchJsonWithRetry(
      "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&page=1",
      { headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" } },
      2
    );
    return { payloads: [payload], source: "geckoterminal" };
  } catch (geckoError) {
    const [profiles, boosts] = await Promise.all([
      fetchJsonWithRetry("https://api.dexscreener.com/token-profiles/recent-updates/v1", {
        headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" },
      }, 2),
      fetchJsonWithRetry("https://api.dexscreener.com/token-boosts/latest/v1", {
        headers: { "User-Agent": "SeekrSolanaMomentum/1.1", Accept: "application/json" },
      }, 2),
    ]);
    const addresses = [...new Set([...profiles, ...boosts]
      .filter((item) => item?.chainId === "solana")
      .map((item) => String(item?.tokenAddress || ""))
      .filter((address) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    )].slice(0, 30);
    if (!addresses.length) throw new Error(`GeckoTerminal unavailable (${String(geckoError)}); DexScreener fallback returned no Solana tokens`);
    const pairs = await fetchJsonWithRetry(
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
  try {
    const discovery = await getSolanaMomentumPayloads();
    const payloads = discovery.payloads;
    const now = Date.now();
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
      .slice(0, 5);
    const results = [];
    for (const call of candidates) {
      try {
        const pair = await getBestPair(call.contract, config.dexId);
        const confirmation = await confirmMarketMomentum(call, pair, { dexId: config.dexId });
        const review = confirmation.review;
        const safety = await getSolanaSafety(call.contract);
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
    return { discovered: tokens.size, checked: candidates.length, results };
  } catch (error) {
    return { discovered: 0, checked: 0, error: String(error) };
  }
}

async function scanBnb(env) {
  if (!env.BITQUERY_TOKEN) return { configured: false, checked: 0, message: "Add BITQUERY_TOKEN to enable" };
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
      getBestPairs(contracts, BNB_CHAIN_ID),
      getBnbSafeties(contracts),
    ]);
    for (const item of candidates) {
      const key = item.contract.toLowerCase();
      try {
        const pair = pairs.get(key) || null;
        const safety = safeties.get(key) || { passed: false, summary: "GoPlus data unavailable" };
        const call = { ...item, name: item.name || pair?.baseToken?.name || pair?.baseToken?.symbol || "BNB token", paid: false, source: "BNB" };
        const confirmation = await confirmMarketMomentum(call, pair, { chainId: BNB_CHAIN_ID, chainName: "BNB Chain" });
        const review = confirmation.review;
        if (pair && safety.passed && confirmation.passed && review.score >= BNB_MIN_SCORE && review.marketCap <= MAX_MARKET_CAP) {
          await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, safety, confirmation }));
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
        const pair = await getBestPair(item.contract, null, ROBINHOOD_CHAIN_ID);
        const call = { ...item, name: pair?.baseToken?.name || pair?.baseToken?.symbol || "Robinhood token", paid: false, source: "ROBINHOOD" };
        const confirmation = await confirmMarketMomentum(call, pair, { chainId: ROBINHOOD_CHAIN_ID, chainName: "Robinhood Chain" });
        const review = confirmation.review;
        if (pair && confirmation.passed && review.score >= ROBINHOOD_MIN_SCORE && review.marketCap <= MAX_MARKET_CAP) {
          await sendTelegram(env, formatAlert(call, confirmation.pair, { ...review, confirmation }));
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
        const pair = await getBestPair(call.contract, "raydium");
        const confirmation = await confirmMarketMomentum(call, pair, { dexId: "raydium" });
        const review = confirmation.review;
        const safety = await getSolanaSafety(call.contract);
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
    const batch = await getBestPairs(contracts.slice(i, i + 30), "solana");
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

async function getBestPair(contract, dexId = null, chainId = "solana") {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
  const data = await check(response).then((r) => r.json());
  let pairs = (data.pairs || []).filter((p) =>
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

async function getBestPairs(contracts, chainId) {
  const best = new Map();
  if (!contracts.length) return best;
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/${chainId}/${contracts.join(",")}`);
  const pairs = await check(response).then((r) => r.json());
  const wanted = new Set(contracts.map((address) => address.toLowerCase()));
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    for (const address of [pair?.baseToken?.address, pair?.quoteToken?.address]) {
      const key = String(address || "").toLowerCase();
      if (!wanted.has(key)) continue;
      const current = best.get(key);
      if (!current || num(pair?.liquidity?.usd) > num(current?.liquidity?.usd)) best.set(key, pair);
    }
  }
  return best;
}

async function getSolanaSafety(contract) {
  try {
    const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${contract}/report`, {
      headers: { "User-Agent": "SeekrSafetyGate/1.0" },
    });
    const data = await check(response).then((r) => r.json());
    return reviewSolanaSafety(data);
  } catch (error) {
    // Fail closed: an unavailable safety report must never become an alert.
    return { passed: false, summary: `blocked: safety report unavailable (${String(error)})` };
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
  const chainId = options.chainId || "solana";
  const chainName = options.chainName || "Solana";
  const initialReview = scorePair(call, initialPair, chainName);
  if (!passesMarketSafety(initialReview)) {
    return { passed: false, pair: initialPair, review: initialReview, initialReview, summary: "blocked by initial momentum gate" };
  }

  // A candidate must remain healthy across two observations before Telegram receives it.
  await new Promise((resolve) => setTimeout(resolve, FINAL_CONFIRM_DELAY_MS));
  const freshPair = await getBestPair(call.contract, options.dexId || null, chainId);
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
async function check(response) { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response; }
