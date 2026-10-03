import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, confirm, insideHours } from './filters.mjs';
const now = Date.parse('2026-10-03T15:10:00Z');
function snapshot(t = now) {
  return {
    mint: 'mintA', chain: 'solana', launchpad: 'pumpfun',
    quoteMint: 'So11111111111111111111111111111111111111112', observedAt: t,
    curve: { verified: true, mint: 'mintA', address: 'curveA', tokenAccount: 'custodyA',
      observedAt: t, complete: false, realTokens: 15, initialRealTokens: 100 },
    market: { capUsd: 60_000, priceUsd: 0.00006, realReserveUsd: 12_000,
      volumeH1: 8_000, buysH1: 30, sellsH1: 15, buyersH1: 20,
      changeM5: 10, changeH1: 20, momentumPct: 10, ageMinutes: 10 },
    safety: { observedAt: t, mintAuthority: null, freezeAuthority: null,
      transferFeePct: 0, rugcheckScore: 10, creatorPct: 2, insiderPct: 0,
      rugged: false, dangerFlags: [], bundleFlags: [], priorCreatorRugFlags: [],
      warnings: [], repeatCreatorCount: 0,
      holders: [{address: 'custodyA', owner: 'curveA', pct: 55, suspicious: false},
        {address: 'walletATA', owner: 'wallet', pct: 5, suspicious: false}] },
  };
}
test('verified custody excluded without removing circulating whale', () => {
  const s = snapshot(); assert.equal(evaluate(s, now).passed, true);
  s.safety.holders.push({ address: 'whaleATA', owner: 'whale', pct: 20, suspicious: false });
  assert.equal(evaluate(s, now).passed, false);
});
test('spoofed custody owner is not exempt', () => {
  const s = snapshot(); s.safety.holders[0].owner = 'attacker';
  assert.equal(evaluate(s, now).passed, false);
});
test('missing risk and hourly metrics fail closed', () => {
  for (const key of ['mintAuthority', 'creatorPct', 'rugcheckScore', 'bundleFlags']) {
    const s = snapshot(); delete s.safety[key]; assert.equal(evaluate(s, now).passed, false);
  }
  const s = snapshot(); delete s.market.buyersH1; assert.equal(evaluate(s, now).passed, false);
});
test('unknown verification, stale data, foreign mint, or completed curve blocked', () => {
  const variants = [s => s.curve.verified = false, s => s.curve.complete = true,
    s => s.curve.mint = 'mintB', s => s.curve.realTokens = 0,
    s => s.curve.observedAt -= 31_000, s => s.observedAt -= 31_000,
    s => s.safety.creatorPct = 5.01, s => s.safety.bundleFlags.push('bundled buyer')];
  for (const change of variants) { const s = snapshot(); change(s); assert.equal(evaluate(s, now).passed, false); }
});
test('confirmation blocks migration, graduation and price deterioration', () => {
  const a = snapshot(now - 20_000), b = snapshot();
  assert.equal(confirm(a, b, now).passed, true);
  b.curve.complete = true; assert.equal(confirm(a, b, now).passed, false);
  b.curve.complete = false; b.curve.address = 'newCurve'; assert.equal(confirm(a, b, now).passed, false);
  b.curve.address = 'curveA'; b.market.priceUsd *= 0.87; assert.equal(confirm(a, b, now).passed, false);
});
test('same observation cannot satisfy confirmation and warning stays a warning', () => {
  assert.equal(confirm(snapshot(), snapshot(), now).passed, false);
  const s = snapshot(); s.safety.warnings = ['copycat risk'];
  assert.equal(evaluate(s, now).passed, true);
  assert.deepEqual(evaluate(s, now).warnings, ['copycat risk']);
});
test('Pacific hours track daylight saving time and cutoff', () => {
  assert.equal(insideHours(Date.parse('2026-10-03T12:00:00Z')), true);
  assert.equal(insideHours(Date.parse('2026-10-04T03:00:00Z')), false);
  assert.equal(insideHours(Date.parse('2026-12-03T12:59:00Z')), false);
  assert.equal(insideHours(Date.parse('2026-12-03T13:00:00Z')), true);
});
