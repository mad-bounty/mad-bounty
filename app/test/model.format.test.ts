import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, relTime, shortAddr, stateLabel, stateTone, usdc, usdcShort, utc, verifierKindLabel } from '../src/model/format';

test('usdc formats with 2 decimals, up to 6 when needed', () => {
  assert.equal(usdc(12_500_000n), '12.50 USDC');
  assert.equal(usdc(1_000_000n), '1.00 USDC');
  assert.equal(usdc(0n), '0.00 USDC');
  assert.equal(usdc(1_234_567n), '1.234567 USDC');
  assert.equal(usdc(10n), '0.00001 USDC');
  assert.equal(usdc(5n), '0.000005 USDC');
  assert.equal(usdc(1_000_000_000n), '1000.00 USDC');
  assert.equal(usdcShort(12_500_000n), '12.50');
  assert.equal(usdcShort(3n), '0.000003');
});

test('shortAddr keeps the 0x…tail shape', () => {
  assert.equal(shortAddr('0x1111111111111111111111111111111111111111'), '0x1111…1111');
  assert.equal(shortAddr('0xabcd'), '0xabcd');
});

test('duration drops empty units', () => {
  assert.equal(duration(0), '0s');
  assert.equal(duration(45), '45s');
  assert.equal(duration(90), '1m 30s');
  assert.equal(duration(3600), '1h');
  assert.equal(duration(3 * 3600 + 12 * 60), '3h 12m');
  assert.equal(duration(86400), '1d');
  assert.equal(duration(2 * 86400 + 3 * 3600), '2d 3h');
  assert.equal(duration(-5), '0s', 'negative clamps: deadlines in the past never render as negative');
});

test('relTime says in/ago from the passed now', () => {
  const now = 1_800_000_000;
  assert.equal(relTime(now + 3 * 3600 + 12 * 60, now), 'in 3h 12m');
  assert.equal(relTime(now - 2 * 86400, now), '2d ago');
  assert.equal(relTime(now, now), 'now');
});

test('utc is a fixed UTC stamp', () => {
  assert.equal(utc(Date.UTC(2026, 10, 27, 14, 0) / 1000), '2026-11-27 14:00 UTC');
  assert.equal(utc(0), '1970-01-01 00:00 UTC');
});

test('labels and tones cover every verifier kind and state', () => {
  assert.equal(verifierKindLabel('self'), 'Poster reviews it (self)');
  assert.equal(verifierKindLabel('onchainCheck'), 'On-chain check');
  assert.equal(verifierKindLabel('hashReveal'), 'Hash reveal');
  assert.equal(verifierKindLabel('teeML'), 'TeeML (0G)');
  assert.equal(verifierKindLabel('multi'), 'Multi-sig panel');
  assert.equal(verifierKindLabel('fallback'), 'Fallback ladder');
  assert.equal(verifierKindLabel('eoa'), 'Single reviewer');
  assert.equal(verifierKindLabel('contract'), 'Smart-contract verifier');
  assert.equal(stateLabel('Paid'), 'Paid');
  assert.equal(stateLabel('Rejected'), 'Rejected (cooling)');
  assert.equal(stateTone('Paid'), 'good');
  assert.equal(stateTone('Rejected'), 'bad');
  assert.equal(stateTone('Submitted'), 'warn');
  assert.equal(stateTone('Open'), 'info');
  assert.equal(stateTone('Cancelled'), 'neutral');
});
