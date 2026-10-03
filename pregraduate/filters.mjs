// Internal normalized snapshots, never untrusted webhook input.
// Ported from worker.js at d55690dd9b608d2819b885d84249da7e695a0bcb.
export const LIMITS = Object.freeze({
  minCurve: 80, maxCurve: 100, maxAgeMs: 30_000,
  minReserveUsd: 10_000, minReserveToCap: 0.05, maxCap: 2_000_000,
  minVolumeH1: 5_000, minBuysH1: 20, minBuyersH1: 15,
  minBuySellRatio: 1.1, minMomentum: 8, minScore: 1,
  maxDropM5: -15, maxDropH1: -30,
  maxHolderPct: 15, maxTop10Pct: 45, maxInsiderPct: 20,
  maxCreatorPct: 5, maxTransferFeePct: 5, maxRugcheckScore: 49,
  confirmationMs: 20_000, maxPriceDrop: 12, maxReserveDrop: 20,
});

const SOL = 'So11111111111111111111111111111111111111112';
const validNumber = n => typeof n === 'number' && Number.isFinite(n);
const validPct = n => validNumber(n) && n >= 0 && n <= 100;
const blocked = reason => ({ passed: false, reasons: [reason] });

export function insideHours(now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23',
  }).format(new Date(now)));
  return hour >= 5 && hour < 20;
}

export function evaluate(s, now = Date.now()) {
  if (!s || !insideHours(now)) return blocked('outside active Pacific hours');
  if (!s.mint || s.chain !== 'solana' || s.launchpad !== 'pumpfun' || s.quoteMint !== SOL)
    return blocked('unverified token identity or unsupported launchpad/quote');
  if (!validNumber(s.observedAt) || now - s.observedAt > LIMITS.maxAgeMs || s.observedAt > now)
    return blocked('stale snapshot');
  // Adapter must derive this PDA for THIS mint, verify program ownership and
  // discriminator, decode current reserves, and read complete from chain.
  const c = s.curve;
  if (!c || c.verified !== true || c.mint !== s.mint || !c.address || !c.tokenAccount ||
      !validNumber(c.observedAt) || now - c.observedAt > LIMITS.maxAgeMs || c.observedAt > now ||
      c.complete !== false || !validNumber(c.initialRealTokens) || c.initialRealTokens <= 0 ||
      !validNumber(c.realTokens) || c.realTokens <= 0 || c.realTokens > c.initialRealTokens)
    return blocked('missing, stale, completed, or unverified bonding curve');
  const progress = 100 * (1 - c.realTokens / c.initialRealTokens);
  if (progress < LIMITS.minCurve || progress >= LIMITS.maxCurve)
    return blocked('outside pre-graduation curve window');
  const m = s.market;
  const keys = ['capUsd', 'priceUsd', 'realReserveUsd', 'volumeH1', 'buysH1',
    'sellsH1', 'buyersH1', 'changeM5', 'changeH1', 'momentumPct', 'ageMinutes'];
  if (!m || keys.some(k => !validNumber(m[k])) ||
      ['volumeH1','buysH1','sellsH1','buyersH1','ageMinutes'].some(k => m[k] < 0))
    return blocked('missing market metrics; cumulative trades cannot substitute for hourly metrics');
  if (m.capUsd <= 0 || m.capUsd > LIMITS.maxCap || m.priceUsd <= 0 ||
      m.realReserveUsd < LIMITS.minReserveUsd || m.realReserveUsd / m.capUsd < LIMITS.minReserveToCap ||
      m.volumeH1 < LIMITS.minVolumeH1 || m.buysH1 < LIMITS.minBuysH1 ||
      m.buyersH1 < LIMITS.minBuyersH1 || m.buysH1 / Math.max(1, m.sellsH1) < LIMITS.minBuySellRatio ||
      m.momentumPct < LIMITS.minMomentum || m.changeM5 < LIMITS.maxDropM5 || m.changeH1 < LIMITS.maxDropH1)
    return blocked('market gate');
  const r = s.safety;
  // Rugcheck's score is retained; another provider's score is not interchangeable.
  if (!r || !validNumber(r.observedAt) || now - r.observedAt > 60_000 || r.observedAt > now ||
      !Object.hasOwn(r, 'mintAuthority') || !Object.hasOwn(r, 'freezeAuthority') ||
      !validPct(r.transferFeePct) || !validNumber(r.rugcheckScore) || r.rugcheckScore < 0 ||
      r.rugcheckScore > 100 || !validPct(r.creatorPct) || !validPct(r.insiderPct) ||
      typeof r.rugged !== 'boolean' || !Array.isArray(r.holders) || !r.holders.length ||
      !Array.isArray(r.dangerFlags) || !Array.isArray(r.bundleFlags) ||
      !Array.isArray(r.priorCreatorRugFlags) || !Array.isArray(r.warnings) ||
      !validNumber(r.repeatCreatorCount) || r.repeatCreatorCount < 0)
    return blocked('missing safety metrics');
  if (r.mintAuthority !== null || r.freezeAuthority !== null || r.rugged ||
      r.transferFeePct > LIMITS.maxTransferFeePct || r.rugcheckScore > LIMITS.maxRugcheckScore ||
      r.creatorPct > LIMITS.maxCreatorPct || r.insiderPct > LIMITS.maxInsiderPct ||
      r.dangerFlags.length || r.bundleFlags.length || r.priorCreatorRugFlags.length)
    return blocked('token/creator/insider/bundle safety gate');
  if (r.holders.some(h => !h.address || !h.owner || !validPct(h.pct) || typeof h.suspicious !== 'boolean'))
    return blocked('incomplete holder data');
  // Exclude only the exact verified curve custody account, never a label or
  // every account held by a program. Percentages retain total-supply denominator.
  const holders = r.holders.filter(h => !(h.address === c.tokenAccount && h.owner === c.address))
    .sort((a, b) => b.pct - a.pct).slice(0, 10);
  if (!holders.length || holders[0].pct > LIMITS.maxHolderPct ||
      holders.reduce((sum, h) => sum + h.pct, 0) > LIMITS.maxTop10Pct || holders.some(h => h.suspicious))
    return blocked('holder concentration or suspicious top holders');
  let score = m.capUsd >= 20_000 && m.capUsd <= 1_500_000 ? 2 : 1;
  score += m.realReserveUsd >= 25_000 ? 2 : 1;
  score += m.volumeH1 >= 20_000 ? 2 : m.volumeH1 >= 7_500 ? 1 : 0;
  score += m.buysH1 >= 20 && m.buysH1 > m.sellsH1 * 1.15 ? 1 : 0;
  score += m.changeH1 >= 5 && m.changeH1 <= 250 ? 1 : 0;
  score += m.ageMinutes <= 180 ? 1 : 0;
  score -= s.paidPromotion === true ? 1 : 0;
  score -= r.repeatCreatorCount > 0 ? 1 : 0;
  return { passed: score >= LIMITS.minScore, score, progress, warnings: r.warnings, reasons: [] };
}

export function confirm(first, fresh, now = Date.now()) {
  if (!first || !fresh || first.mint !== fresh.mint || first.curve?.address !== fresh.curve?.address)
    return blocked('token or curve changed during confirmation');
  if (!validNumber(first.observedAt) || !validNumber(fresh.observedAt) ||
      fresh.observedAt - first.observedAt < LIMITS.confirmationMs ||
      fresh.observedAt - first.observedAt > LIMITS.maxAgeMs)
    return blocked('two observations must be 20–30 seconds apart');
  const a = evaluate(first, first.observedAt), b = evaluate(fresh, now);
  if (!a.passed || !b.passed) return blocked('initial or fresh filters failed');
  if ((1 - fresh.market.priceUsd / first.market.priceUsd) * 100 > LIMITS.maxPriceDrop ||
      (1 - fresh.market.realReserveUsd / first.market.realReserveUsd) * 100 > LIMITS.maxReserveDrop)
    return blocked('price or real reserves deteriorated during confirmation');
  return b;
}
