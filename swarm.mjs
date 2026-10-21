// Experimental trigger, not a probability of profit. No points or ranking score.
export const SWARM = Object.freeze({ windowMs: 60_000, minBuyers: 8,
  buyerAcceleration: 1.5, minNewBuyers: 5, minBuyUsd: 750,
  dollarAcceleration: 1.5, minNetBuyUsd: 300, minBuySellRatio: 1.5,
  maxWalletShare: 0.35, maxTradeAgeMs: 30_000, minPriceRisePct: 0.5 });

export function detectSwarm(payload, contract, now = Date.now()) {
  const blocked = (summary) => ({ passed: false, summary });
  if (!Array.isArray(payload?.data) || !payload.data.length) return blocked('Trade data unavailable');
  const trades = [], seen = new Set();
  for (const row of payload.data) {
    const a = row?.attributes || {}, at = Date.parse(a.block_timestamp);
    if (!Number.isFinite(at)) return blocked('Invalid trade timestamp');
    if (at <= now - 2 * SWARM.windowMs) continue;
    if (at > now + 5_000) return blocked('Future trade timestamp');
    if (at > now) continue;
    if (a.is_anomalous === true) return blocked('Provider marked an anomalous trade');
    const buy = a.kind === 'buy', sell = a.kind === 'sell';
    if (!buy && !sell) return blocked('Unknown trade direction');
    if ((buy ? a.to_token_address : a.from_token_address) !== contract)
      return blocked('Trade token does not match candidate');
    const wallet = a.tx_from_address, usd = Number(a.volume_in_usd);
    const price = Number(buy ? a.price_to_in_usd : a.price_from_in_usd);
    const id = row.id;
    if (!id || !wallet || !a.tx_hash || !Number.isFinite(usd) || usd <= 0 ||
        !Number.isFinite(price) || price <= 0) return blocked('Incomplete trade fields');
    if (seen.has(id)) continue;
    seen.add(id);
    trades.push({ at, buy, wallet, usd, price });
  }
  // Public endpoint returns the latest 300 trades. Never compare truncated windows.
  const oldest = Math.min(...payload.data.map(r => Date.parse(r.attributes?.block_timestamp)));
  if (payload.data.length >= 300 && oldest > now - 2 * SWARM.windowMs)
    return blocked('Trade window truncated; streaming or paginated feed required');
  trades.sort((a,b) => a.at-b.at);
  if (!trades.length || now - trades.at(-1).at > SWARM.maxTradeAgeMs)
    return blocked('Trade data stale');
  const summarize = rows => {
    const wallets = new Map(); let buyUsd = 0, sellUsd = 0;
    for (const t of rows) if (t.buy) {
      buyUsd += t.usd; wallets.set(t.wallet, (wallets.get(t.wallet) || 0) + t.usd);
    } else sellUsd += t.usd;
    return { wallets, buyers: wallets.size, buyUsd, sellUsd, netBuyUsd: buyUsd-sellUsd };
  };
  const currentRows = trades.filter(t => t.at > now - SWARM.windowMs);
  const previous = summarize(trades.filter(t => t.at <= now - SWARM.windowMs));
  const current = summarize(currentRows);
  const newBuyers = [...current.wallets.keys()].filter(w => !previous.wallets.has(w)).length;
  const buyerAcceleration = current.buyers / Math.max(1, previous.buyers);
  const dollarAcceleration = current.buyUsd / Math.max(1, previous.buyUsd);
  const walletShare = Math.max(0,...current.wallets.values()) / Math.max(1,current.buyUsd);
  const priceRisePct = currentRows.length > 1
    ? (currentRows.at(-1).price/currentRows[0].price-1)*100 : 0;
  const reasons = [];
  if (current.buyers < SWARM.minBuyers || buyerAcceleration < SWARM.buyerAcceleration ||
      newBuyers < SWARM.minNewBuyers) reasons.push('buyers not accelerating');
  if (current.buyUsd < SWARM.minBuyUsd || dollarAcceleration < SWARM.dollarAcceleration ||
      current.netBuyUsd < SWARM.minNetBuyUsd || current.netBuyUsd <= previous.netBuyUsd ||
      current.buyUsd < current.sellUsd * SWARM.minBuySellRatio) reasons.push('net demand not accelerating');
  if (walletShare > SWARM.maxWalletShare) reasons.push('buying concentrated in one wallet');
  if (priceRisePct < SWARM.minPriceRisePct) reasons.push('price not responding');
  return { passed: reasons.length === 0,
    summary: reasons.length ? reasons.join('; ') : 'Buyer and net-dollar acceleration detected',
    buyers: current.buyers, previousBuyers: previous.buyers, newBuyers,
    buyUsd: current.buyUsd, sellUsd: current.sellUsd, netBuyUsd: current.netBuyUsd,
    buyerAcceleration, dollarAcceleration, walletShare, priceRisePct,
    observedAt: now, windowSeconds: SWARM.windowMs/1000,
    // Distinct addresses do not establish that wallets are independently controlled.
    walletIndependenceVerified: false };
}
