import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { keccak256, toHex, encodeAbiParameters, type Address, type Hex } from 'viem';
import {
  buildPostParams,
  buildSpecJson,
  defaultForm,
  derive,
  describe,
  encodeVerifierInit,
  hashRevealCommitment,
  isIndependentVerifier,
  verifierAddressFor,
  type PostCtx,
} from '../src/model/postForm';
import type { PostFormState, VerifierChoice } from '../src/types';

const ME = '0x1111111111111111111111111111111111111111' as Address;
const A1 = '0x1111111111111111111111111111111111111111' as Address;
const A2 = '0x2222222222222222222222222222222222222222' as Address;
const A3 = '0x3333333333333333333333333333333333333333' as Address;
const TARGET = '0x4444444444444444444444444444444444444444' as Address;
const NOW = 1_800_000_000;
const ADAPTERS = {
  fallback: '0x0e02866358fbCB186c1B6a520938400bdD8a2Dee' as Address,
  onchainCheck: '0xBfC7F4145cbC09a79C2afb3F3170Fe211849cE1c' as Address,
  hashReveal: '0x40bD8730095B5925f7FA1Da9bec35F1B7243b74E' as Address,
  teeML: '0x4211ED6f52B76AC38E43Bf8BF059b22689e3De1B' as Address,
  multi: '0x356ba86B972fe2ce3320DF390A8c2341A01cd601' as Address,
};
const CTX: PostCtx = { me: ME, feeBps: 500n, now: NOW, adapters: ADAPTERS };

function form(over: Partial<PostFormState> = {}): PostFormState {
  return {
    ...defaultForm(),
    title: 'Photograph the storefront',
    instructions: 'Take a clear photo of the shop sign and post it to IPFS.',
    criteria: ['The sign is readable', 'The photo is taken after 10:00 UTC'],
    evidenceFormat: 'photo.jpg | image/jpeg',
    rewardUsdc: '100',
    ...over,
  };
}

// ---------------------------------------------------------------- form basics
test('defaultForm is a blank, safe starting point', () => {
  const f = defaultForm();
  assert.equal(f.title, '');
  assert.equal(f.rewardUsdc, '');
  assert.equal(f.depositUsdc, '');
  assert.equal(f.workWindowHours, 24);
  assert.equal(f.reviewWindowHours, 24);
  assert.equal(f.openDays, 7);
  assert.deepEqual(f.verifier, { kind: 'self' });
  assert.equal(f.rejectMode, 'Burn');
  assert.equal(f.claimAuthorizer, '');
  assert.deepEqual(f.criteria, ['']);
});

test('an empty form reports the required fields', () => {
  const d = derive(defaultForm(), CTX);
  assert.equal(d.ok, false);
  for (const k of ['title', 'instructions', 'criteria', 'rewardUsdc']) {
    assert.ok(d.errors[k as keyof typeof d.errors], `missing error for ${k}`);
  }
});

test('a complete form is valid with min deposit defaulted', () => {
  const d = derive(form(), CTX);
  assert.deepEqual(d.errors, {});
  assert.equal(d.ok, true);
  assert.equal(d.reward, 100_000_000n);
  assert.equal(d.minDeposit, 2_000_000n);
  assert.equal(d.deposit, 2_000_000n);
  assert.equal(d.fee, 5_000_000n);
  assert.equal(d.workerGetsOnAccept, 97_000_000n);
  assert.equal(d.burnedOnReject, 102_000_000n);
  assert.equal(d.agentBackOnReject, 0n);
});

test('REFUND switches the derived reject outcomes', () => {
  const d = derive(form({ rejectMode: 'Refund' }), CTX);
  assert.equal(d.burnedOnReject, 2_000_000n);
  assert.equal(d.agentBackOnReject, 100_000_000n);
});

// ------------------------------------------------------------------ bounds
test('reward bounds are exact: $1 .. $1,000', () => {
  const cases: [string, boolean][] = [
    ['0.999999', false],
    ['1', true],
    ['1000', true],
    ['1000.000001', false],
    ['0', false],
    ['-5', false],
    ['abc', false],
    ['1.1234567', false],
  ];
  for (const [rewardUsdc, ok] of cases) {
    const d = derive(form({ rewardUsdc }), CTX);
    assert.equal(d.ok, ok, `reward ${rewardUsdc} should be ${ok ? 'valid' : 'invalid'}: ${JSON.stringify(d.errors)}`);
    if (!ok) assert.ok(d.errors.rewardUsdc);
  }
});

test('min deposit is max(1 USDC, 2%) and deposit <= reward', () => {
  assert.equal(derive(form({ rewardUsdc: '10' }), CTX).minDeposit, 1_000_000n);
  assert.equal(derive(form({ rewardUsdc: '50' }), CTX).minDeposit, 1_000_000n);
  assert.equal(derive(form({ rewardUsdc: '50.000001' }), CTX).minDeposit, 1_000_000n);
  assert.equal(derive(form({ rewardUsdc: '51' }), CTX).minDeposit, 1_020_000n);
  assert.equal(derive(form({ rewardUsdc: '1000' }), CTX).minDeposit, 20_000_000n);

  const low = derive(form({ rewardUsdc: '100', depositUsdc: '1.99' }), CTX);
  assert.equal(low.ok, false);
  assert.match(low.errors.depositUsdc!, /at least 2\.00 USDC/);

  const high = derive(form({ rewardUsdc: '100', depositUsdc: '100.000001' }), CTX);
  assert.equal(high.ok, false);
  assert.match(high.errors.depositUsdc!, /cannot exceed/);

  const equal = derive(form({ rewardUsdc: '100', depositUsdc: '100' }), CTX);
  assert.equal(equal.ok, true, 'deposit == reward is allowed by post()');
  assert.equal(equal.deposit, 100_000_000n);
  assert.equal(equal.workerGetsOnAccept, 195_000_000n);
});

test('work window 1h..30d, review window 12h..30d', () => {
  const works: [number, boolean][] = [[0.5, false], [1, true], [24, true], [720, true], [720.5, false]];
  for (const [workWindowHours, ok] of works) {
    const d = derive(form({ workWindowHours }), CTX);
    assert.equal(!d.errors.workWindowHours, ok, `work ${workWindowHours}h`);
  }
  const reviews: [number, boolean][] = [[11, false], [11.9, false], [12, true], [24, true], [720, true], [721, false]];
  for (const [reviewWindowHours, ok] of reviews) {
    const d = derive(form({ reviewWindowHours }), CTX);
    assert.equal(!d.errors.reviewWindowHours, ok, `review ${reviewWindowHours}h`);
  }
});

test('openUntil must be in the future and at most 180 days', () => {
  assert.equal(derive(form({ openDays: 180 }), CTX).errors.openDays, undefined);
  assert.equal(derive(form({ openDays: 181 }), CTX).errors.openDays !== undefined, true);
  assert.equal(derive(form({ openDays: 0 }), CTX).errors.openDays !== undefined, true);
  assert.equal(derive(form({ openDays: -1 }), CTX).errors.openDays !== undefined, true);
  assert.equal(buildPostParams(form({ openDays: 180 }), CTX).openUntil, BigInt(NOW + 180 * 86400));
});

test('text bounds: title 3..120, instructions >= 10, criteria 1..50 and >= 3 chars', () => {
  assert.ok(derive(form({ title: 'ab' }), CTX).errors.title);
  assert.equal(derive(form({ title: 'abc' }), CTX).errors.title, undefined);
  assert.equal(derive(form({ title: 'x'.repeat(120) }), CTX).errors.title, undefined);
  assert.ok(derive(form({ title: 'x'.repeat(121) }), CTX).errors.title);
  assert.ok(derive(form({ instructions: 'short' }), CTX).errors.instructions);
  assert.equal(derive(form({ instructions: 'long enough' }), CTX).errors.instructions, undefined);
  assert.ok(derive(form({ criteria: ['', '  '] }), CTX).errors.criteria);
  assert.ok(derive(form({ criteria: ['ab'] }), CTX).errors.criteria);
  assert.equal(derive(form({ criteria: ['abc'] }), CTX).errors.criteria, undefined);
  assert.ok(derive(form({ criteria: Array.from({ length: 51 }, (_, i) => `criterion ${i}`) }), CTX).errors.criteria);
});

test('claim authorizer must be a valid checksummed address or empty', () => {
  assert.equal(derive(form({ claimAuthorizer: '' }), CTX).errors.claimAuthorizer, undefined);
  assert.ok(derive(form({ claimAuthorizer: '0xnope' }), CTX).errors.claimAuthorizer);
  // mixed case with a broken checksum
  const bad = '0x0e02866358fbCB186c1B6a520938400bdD8a2dee';
  assert.ok(derive(form({ claimAuthorizer: bad }), CTX).errors.claimAuthorizer);
});

// ----------------------------------------------------------------- verifier
test('self verifier needs a wallet and warns on REFUND (A6)', () => {
  const noWallet = derive(form(), { feeBps: 500n, now: NOW });
  assert.ok(noWallet.errors.verifier);

  const self = derive(form(), CTX);
  assert.equal(self.ok, true);
  assert.equal(verifierAddressFor({ kind: 'self' }, CTX), ME);
  assert.equal(isIndependentVerifier({ kind: 'self' }, CTX), false);

  const refundSelf = derive(form({ rejectMode: 'Refund' }), CTX);
  assert.equal(refundSelf.ok, true, 'warned, not blocked');
  assert.ok(refundSelf.warnings.some((w) => w.startsWith('A6')));
});

test('address verifier validates and warns when it is the poster', () => {
  const other: VerifierChoice = { kind: 'address', address: A2 };
  assert.equal(derive(form({ verifier: other }), CTX).errors.verifier, undefined);
  assert.ok(derive(form({ verifier: { kind: 'address', address: '0x1234' } }), CTX).errors.verifier);
  const self = derive(form({ verifier: { kind: 'address', address: ME } }), CTX);
  assert.ok(self.warnings.some((w) => /not independent/.test(w)));
});

test('multi: threshold 1..n, unique sorted signers, at most 7, majority warning', () => {
  const base = { kind: 'multi' as const, signers: [A1, A2, A3], threshold: 2 };
  const ok = derive(form({ verifier: base }), CTX);
  assert.equal(ok.errors.verifier, undefined);
  assert.deepEqual(ok.warnings, [], '2 of 3 is a strict majority');

  const even = derive(form({ verifier: { ...base, signers: [A1, A2, A3, TARGET], threshold: 2 } }), CTX);
  assert.ok(even.warnings.some((w) => /strict majority/.test(w)));

  const zero = derive(form({ verifier: { ...base, threshold: 0 } }), CTX);
  assert.ok(zero.errors.verifier);
  const over = derive(form({ verifier: { ...base, threshold: 4 } }), CTX);
  assert.ok(over.errors.verifier);
  const dup = derive(form({ verifier: { ...base, signers: [A1, A1] } }), CTX);
  assert.match(dup.errors.verifier!, /unique/);
  const tooMany = derive(form({ verifier: { ...base, signers: [A1, A2, A3, TARGET, '0x5555555555555555555555555555555555555555' as Address, '0x6666666666666666666666666666666666666666' as Address, '0x7777777777777777777777777777777777777777' as Address, '0x8888888888888888888888888888888888888888' as Address], threshold: 2 } }), CTX);
  assert.match(tooMany.errors.verifier!, /at most 7/i);
});

test('fallback: stepTimeout × (signers − 1) must fit inside the review window', () => {
  const ch = (stepSeconds: number, reviewWindowHours = 24): VerifierChoice => ({
    kind: 'fallback', signers: [A1, A2], stepSeconds,
  });
  const reviewSec = 24 * 3600;
  // boundary: step*(n-1) == reviewWindow must fail (contract uses >=)
  assert.ok(derive(form({ verifier: ch(reviewSec), reviewWindowHours: 24 }), CTX).errors.verifier);
  assert.equal(derive(form({ verifier: ch(reviewSec - 1), reviewWindowHours: 24 }), CTX).errors.verifier, undefined);
  assert.ok(derive(form({ verifier: ch(0) }), CTX).errors.verifier);
  const single: VerifierChoice = { kind: 'fallback', signers: [A1], stepSeconds: 0 };
  const one = derive(form({ verifier: single }), CTX);
  assert.equal(one.ok, true, 'a single signer needs no step timeout (n-1 == 0)');
});

test('hash reveal: commitment, window >= 1h and <= review − 12h, entropy warning', () => {
  const ch = (revealWindowSeconds: number, answer = 'secret-answer-123', salt = ''): VerifierChoice => ({
    kind: 'hashReveal', answer, salt, revealWindowSeconds,
  });
  // review 24h: max window is exactly 12h
  assert.equal(derive(form({ verifier: ch(43200), reviewWindowHours: 24 }), CTX).errors.verifier, undefined);
  assert.ok(derive(form({ verifier: ch(43201), reviewWindowHours: 24 }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: ch(3599), reviewWindowHours: 24 }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: ch(3600), reviewWindowHours: 12 }), CTX).errors.verifier, 'review of exactly 12h leaves no room');
  assert.ok(derive(form({ verifier: ch(3600, '') }), CTX).errors.verifier);
  const short = derive(form({ verifier: ch(3600, 'abc') }), CTX);
  assert.ok(short.warnings.some((w) => /brute-forced/.test(w)));
  // a salt field is ignored by the contract's commitment, so the form must say so
  const salted = derive(form({ verifier: ch(3600, 'secret-answer-123', 'pepper') }), CTX);
  assert.ok(salted.warnings.some((w) => /not part of the commitment/.test(w)));
  assert.equal(
    encodeVerifierInit(ch(3600, 'secret-answer-123', 'pepper')),
    encodeVerifierInit(ch(3600, 'secret-answer-123')),
    'the salt cannot change the on-chain commitment',
  );
  // the commitment is keccak256(abi.encode(bytes answer)), as HashRevealVerifier.commit() computes it
  assert.equal(
    hashRevealCommitment('secret-answer-123'),
    '0x7219f2d6f076282712a391ecfdb77f4aed53bb3d51020a6ef40912ed95ed2374',
  );
});

test('onchain check: target, hex calldata, 32-byte expected hash, window', () => {
  const good: VerifierChoice = {
    kind: 'onchainCheck', target: TARGET, calldata: '0x1234abcd',
    expectedReturn: '0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6',
    checkWindowSeconds: 3600,
  };
  assert.equal(derive(form({ verifier: good, reviewWindowHours: 24 }), CTX).errors.verifier, undefined);
  assert.ok(derive(form({ verifier: { ...good, target: '0x1234' } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, calldata: 'abcd' } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, expectedReturn: '0x1234' } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, checkWindowSeconds: 3599 } }), CTX).errors.verifier);
  // REFUND + on-chain check is a known theft path (r3 F-1d)
  const refund = derive(form({ verifier: good, rejectMode: 'Refund' }), CTX);
  assert.ok(refund.warnings.some((w) => /on-chain check/.test(w)));
});

test('teeML: signers, template required, window bounds, template warnings', () => {
  const good: VerifierChoice = {
    kind: 'teeML', enclaveSigners: [A1],
    promptPrefix: '{"model":"x","messages":[{"role":"user","content":"Judge: ',
    promptSuffix: ' End with VERDICT:Y or VERDICT:N."}]}',
    windowSeconds: 3600,
  };
  const ok = derive(form({ verifier: good, reviewWindowHours: 24 }), CTX);
  assert.equal(ok.errors.verifier, undefined);
  assert.ok(ok.warnings.some((w) => /VERDICT/.test(w)), 'template mentioning VERDICT earns a warning');
  assert.ok(!ok.warnings.some((w) => /double quotes/.test(w)), 'the JSON prefix leaves an open string');

  assert.ok(derive(form({ verifier: { ...good, promptPrefix: '' } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, enclaveSigners: [] } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, enclaveSigners: [A1, A2, A3, TARGET] } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, enclaveSigners: [A1, A1] } }), CTX).errors.verifier);
  assert.ok(derive(form({ verifier: { ...good, windowSeconds: 100 } }), CTX).errors.verifier);
  const unquoted = derive(form({ verifier: { ...good, promptPrefix: 'Judge this evidence: ' } }), CTX);
  assert.ok(unquoted.warnings.some((w) => /double quotes/.test(w)));
});

test('an adapter verifier that is not deployed on the chain is an error', () => {
  const d = derive(form({ verifier: { kind: 'multi', signers: [A1], threshold: 1 } }), { me: ME, feeBps: 500n, now: NOW });
  assert.match(d.errors.verifier!, /not deployed/);
});

// --------------------------------------------------------------------- spec
/** Minimal JSON-Schema subset: the keywords this schema actually uses. */
function validate(schema: any, value: any, path = '$'): string[] {
  const errs: string[] = [];
  const type = (v: any) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  if (schema.const !== undefined && value !== schema.const) errs.push(`${path}: const ${JSON.stringify(schema.const)} != ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  if (schema.type) {
    const t = type(value);
    const okType = schema.type === t || (schema.type === 'integer' && t === 'number' && Number.isInteger(value)) || (schema.type === 'number' && t === 'number');
    if (!okType) return [...errs, `${path}: expected ${schema.type}, got ${t}`];
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern ${schema.pattern} failed for ${value}`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v: any) => JSON.stringify(v))).size !== value.length) errs.push(`${path}: items not unique`);
    if (schema.items) value.forEach((v: any, i: number) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (schema.type === 'object') {
    for (const req of schema.required ?? []) if (!(req in value)) errs.push(`${path}: missing required ${req}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected property ${k}`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  return errs;
}

const SCHEMA = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/schemas/bounty-spec.schema.json'), 'utf8'),
);

test('buildSpecJson produces a madb-spec/1 document that passes docs/schemas/bounty-spec.schema.json', () => {
  for (const verifier of [
    { kind: 'self' } as VerifierChoice,
    { kind: 'address', address: A2 } as VerifierChoice,
    { kind: 'multi', signers: [A3, A1, A2], threshold: 2 } as VerifierChoice,
    { kind: 'fallback', signers: [A1, A2], stepSeconds: 7200 } as VerifierChoice,
    { kind: 'hashReveal', answer: 'secret-answer-123', salt: '', revealWindowSeconds: 3600 } as VerifierChoice,
    { kind: 'onchainCheck', target: TARGET, calldata: '0x1234abcd', expectedReturn: '0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6', checkWindowSeconds: 3600 } as VerifierChoice,
    { kind: 'teeML', enclaveSigners: [A1], promptPrefix: '{"m":[{"role":"user","content":"', promptSuffix: '"}],"temperature":0}', windowSeconds: 3600 } as VerifierChoice,
  ]) {
    const json = buildSpecJson(form({ verifier }), CTX);
    const parsed = JSON.parse(json);
    assert.deepEqual(validate(SCHEMA, parsed), [], `spec invalid for ${verifier.kind}: ${json}`);
    assert.equal(parsed.specVersion, 'madb-spec/1');
  }
});

test('spec content mirrors the form and the on-chain params', () => {
  const f = form({ summary: '  A short summary  ', criteria: ['One criterion', '', 'Two criterion'] });
  const spec = JSON.parse(buildSpecJson(f, CTX));
  assert.equal(spec.title, 'Photograph the storefront');
  assert.equal(spec.summary, 'A short summary');
  assert.equal(spec.language, 'en');
  assert.deepEqual(spec.acceptanceCriteria.map((c: any) => c.id), ['c1', 'c2'], 'blank criteria are dropped and ids renumbered');
  assert.equal(spec.acceptanceCriteria[0].required, true);
  assert.equal(spec.evidenceFormat.manifest, 'madb-evidence/1');
  assert.deepEqual(spec.evidenceFormat.items, [{ name: 'photo.jpg', mediaType: 'image/jpeg' }]);
  assert.equal(spec.deadlines.workWindowSec, 86400);
  assert.equal(spec.deadlines.reviewWindowSec, 86400);
  assert.equal(spec.deadlines.openUntil, NOW + 7 * 86400);
  assert.equal(spec.verifier.type, 'self');
  assert.equal(spec.verifier.address, ME);
  assert.equal(spec.verifier.independentOfAgent, false);
  assert.ok(!('summary' in JSON.parse(buildSpecJson(form({ summary: '' }), CTX))), 'empty summary is omitted');
});

test('evidence items default to one octet-stream item', () => {
  const spec = JSON.parse(buildSpecJson(form({ evidenceFormat: '' }), CTX));
  assert.equal(spec.evidenceFormat.items.length, 1);
  assert.equal(spec.evidenceFormat.items[0].mediaType, 'application/octet-stream');
  const multi = JSON.parse(buildSpecJson(form({ evidenceFormat: 'a.png | image/png | screenshot\nfile.txt' }), CTX));
  assert.deepEqual(multi.evidenceFormat.items[0], { name: 'a.png', mediaType: 'image/png', description: 'screenshot' });
  assert.deepEqual(multi.evidenceFormat.items[1], { name: 'file.txt', mediaType: 'application/octet-stream' });
});

test('spec size is capped at 16 KB', () => {
  const okForm = form({ instructions: 'x'.repeat(15_000) });
  assert.ok(new TextEncoder().encode(buildSpecJson(okForm, CTX)).length <= 16 * 1024);
  assert.equal(derive(okForm, CTX).errors.spec, undefined);

  const big = form({ instructions: 'x'.repeat(16_500) });
  const d = derive(big, CTX);
  assert.match(d.errors.spec ?? '', /cap is 16 KB/);
  assert.equal(d.ok, false);
});

// -------------------------------------------------------------- post params
test('buildPostParams fills every field from the form and context', () => {
  const p = buildPostParams(form({ depositUsdc: '5', claimAuthorizer: A2, openDays: 3, workWindowHours: 6, reviewWindowHours: 48 }), CTX);
  assert.equal(p.verifier, ME);
  assert.equal(p.claimAuthorizer, A2);
  assert.equal(p.reward, 100_000_000n);
  assert.equal(p.deposit, 5_000_000n);
  assert.equal(p.workWindow, 6 * 3600);
  assert.equal(p.reviewWindow, 48 * 3600);
  assert.equal(p.openUntil, BigInt(NOW + 3 * 86400));
  assert.equal(p.rejectMode, 'Burn');
  assert.equal(p.encKey, '0x');
  assert.equal(p.verifierInit, '0x');
  assert.equal(p.specHash, keccak256(toHex(buildSpecJson(form({ depositUsdc: '5', claimAuthorizer: A2, openDays: 3, workWindowHours: 6, reviewWindowHours: 48 }), CTX))));

  const blank = buildPostParams(form(), CTX);
  assert.equal(blank.claimAuthorizer, '0x0000000000000000000000000000000000000000');
  assert.equal(blank.deposit, 2_000_000n, 'blank deposit means the minimum');
});

test('verifier address resolution: self, address, and each adapter', () => {
  assert.equal(verifierAddressFor({ kind: 'self' }, CTX), ME);
  assert.equal(verifierAddressFor({ kind: 'address', address: A2 }, CTX), A2);
  assert.equal(verifierAddressFor({ kind: 'fallback', signers: [], stepSeconds: 0 }, CTX), ADAPTERS.fallback);
  assert.equal(verifierAddressFor({ kind: 'multi', signers: [], threshold: 1 }, CTX), ADAPTERS.multi);
  assert.equal(verifierAddressFor({ kind: 'hashReveal', answer: '', salt: '', revealWindowSeconds: 3600 }, CTX), ADAPTERS.hashReveal);
  assert.equal(verifierAddressFor({ kind: 'onchainCheck', target: TARGET, calldata: '0x', expectedReturn: '0x', checkWindowSeconds: 3600 }, CTX), ADAPTERS.onchainCheck);
  assert.equal(verifierAddressFor({ kind: 'teeML', enclaveSigners: [], promptPrefix: 'a', promptSuffix: 'b', windowSeconds: 3600 }, CTX), ADAPTERS.teeML);
});

// ------------------------------------------------------------------ params
/**
 * Expected bytes computed once with foundry cast (the same tooling deployments/e2e_full.py uses):
 *   cast abi-encode 'f(address[],uint32)'  '[0x1111..,0x2222..]' 7200
 *   cast abi-encode 'f(address[],uint8)'   '[0x1111..,0x2222..,0x3333..]' 2
 *   cast abi-encode 'f(bytes32,uint32)'    $(cast keccak $(cast abi-encode 'f(bytes)' $(cast from-utf8 secret-answer-123))) 3600
 *   cast abi-encode 'f(address,bytes,bytes32,uint32)' 0x4444.. 0x1234abcd $(cast keccak $(cast abi-encode 'f(bool)' true)) 3600
 *   cast abi-encode 'f(address[],bytes32,bytes32,uint32)' '[0x1111..]' $(cast keccak PRE) $(cast keccak SUF) 3600
 */
const CAST = {
  fallback: '0x00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000001c20000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222',
  fallbackSingle: '0x0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000001111111111111111111111111111111111111111',
  multi: '0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003000000000000000000000000111111111111111111111111111111111111111100000000000000000000000022222222222222222222222222222222222222220000000000000000000000003333333333333333333333333333333333333333',
  hashReveal: '0x7219f2d6f076282712a391ecfdb77f4aed53bb3d51020a6ef40912ed95ed23740000000000000000000000000000000000000000000000000000000000000e10',
  onchainCheck: '0x00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000000000000000000080b10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf60000000000000000000000000000000000000000000000000000000000000e1000000000000000000000000000000000000000000000000000000000000000041234abcd00000000000000000000000000000000000000000000000000000000',
  teeML: '0x000000000000000000000000000000000000000000000000000000000000008072d3692b8a6fb0f4b99acaca190bf3b4006a534b0c3cce61f2616fa1458cd5572f9611d6feb8f4f3a9a40478f16b50e1c7639205ef623b8995c218ef7759c1910000000000000000000000000000000000000000000000000000000000000e1000000000000000000000000000000000000000000000000000000000000000010000000000000000000000001111111111111111111111111111111111111111',
} as const;

test('verifierInit encodings are byte-identical to cast/e2e_full.py', () => {
  assert.equal(
    encodeVerifierInit({ kind: 'fallback', signers: [A1, A2], stepSeconds: 7200 }),
    CAST.fallback,
  );
  assert.equal(
    encodeVerifierInit({ kind: 'fallback', signers: [A1], stepSeconds: 0 }),
    CAST.fallbackSingle,
  );
  assert.equal(
    encodeVerifierInit({ kind: 'multi', signers: [A1, A2, A3], threshold: 2 }),
    CAST.multi,
  );
  assert.equal(
    encodeVerifierInit({ kind: 'hashReveal', answer: 'secret-answer-123', salt: '', revealWindowSeconds: 3600 }),
    CAST.hashReveal,
  );
  assert.equal(
    encodeVerifierInit({ kind: 'onchainCheck', target: TARGET, calldata: '0x1234abcd', expectedReturn: '0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6', checkWindowSeconds: 3600 }),
    CAST.onchainCheck,
  );
  assert.equal(
    encodeVerifierInit({ kind: 'teeML', enclaveSigners: [A1], promptPrefix: 'PRE', promptSuffix: 'SUF', windowSeconds: 3600 }),
    CAST.teeML,
  );
  assert.equal(encodeVerifierInit({ kind: 'self' }), '0x');
  assert.equal(encodeVerifierInit({ kind: 'address', address: A2 }), '0x');
});

test('multi signers are sorted ascending (MultiVerifier._set reverts NotSorted otherwise)', () => {
  const unsorted = encodeVerifierInit({ kind: 'multi', signers: [A3, A1, A2], threshold: 2 });
  assert.equal(unsorted, CAST.multi);
  const p = buildPostParams(form({ verifier: { kind: 'multi', signers: [A3, A1, A2], threshold: 2 } }), CTX);
  assert.equal(p.verifier, ADAPTERS.multi);
  assert.equal(p.verifierInit, CAST.multi);
});

test('buildPostParams carries the adapter verifierInit end to end', () => {
  const p = buildPostParams(form({ verifier: { kind: 'fallback', signers: [A1, A2], stepSeconds: 7200 } }), CTX);
  assert.equal(p.verifier, ADAPTERS.fallback);
  assert.equal(p.verifierInit, CAST.fallback);
  const spec = JSON.parse(buildSpecJson(form({ verifier: { kind: 'fallback', signers: [A2, A1], stepSeconds: 7200 } }), CTX));
  assert.deepEqual(spec.verifier.config.signers, [A1, A2], 'spec lists the same sorted order as the encoding');
});

// ----------------------------------------------------------------- describe
test('describe explains the money, parties and rules for the confirm screen', () => {
  const f = form({ rejectMode: 'Refund' });
  const d = derive(f, CTX);
  const lines = describe(f, d, CTX);
  assert.ok(lines.length >= 6);
  const all = lines.join('\n');
  assert.match(all, /You lock 100\.00 USDC/);
  assert.match(all, /lock 2\.00 USDC to claim/);
  assert.match(all, /Verifier: you \(the poster\)/);
  assert.match(all, /97\.00 USDC/);
  assert.match(all, /5\.00 USDC/);
  assert.match(all, /100\.00 USDC comes back to you/);
  assert.match(all, /2\.00 USDC \(the deposit\) is burned/);
  assert.match(all, /Claims close \d{4}-/);
  assert.match(all, /Not externally audited/);
  for (const l of lines) assert.ok(l.length > 10, `line too short: ${l}`);
});

test('describe names adapters by kind and address', () => {
  const f = form({ verifier: { kind: 'multi', signers: [A1, A2, A3], threshold: 2 } });
  const lines = describe(f, derive(f, CTX), CTX).join('\n');
  assert.match(lines, /Multi-sig panel 0x356b…d601/);
});

test('the hash-reveal answer is committed as UTF-8 text (documented, warned about for hex)', () => {
  const hexish: VerifierChoice = { kind: 'hashReveal', answer: '0xdeadbeef', salt: '', revealWindowSeconds: 3600 };
  const d = derive(form({ verifier: hexish }), CTX);
  assert.ok(d.warnings.some((w) => /UTF-8 text/.test(w)));
  // hashRevealCommitment('0xdeadbeef') hashes the 10 ASCII bytes, not the 4 raw bytes
  assert.equal(hashRevealCommitment('0xdeadbeef'), keccak256(encodeAbiParameters([{ type: 'bytes' }], [toHex('0xdeadbeef')])));
  assert.notEqual(hashRevealCommitment('0xdeadbeef'), keccak256(encodeAbiParameters([{ type: 'bytes' }], ['0xdeadbeef'])));
});

// ------------------------------------------------------------- hostile input
test('odd inputs never throw', () => {
  const weird: Partial<PostFormState>[] = [
    { rewardUsdc: '1'.repeat(400) },
    { rewardUsdc: ' ' },
    { depositUsdc: 'NaN' },
    { workWindowHours: Number.NaN },
    { reviewWindowHours: Number.POSITIVE_INFINITY },
    { openDays: Number.NaN },
    { criteria: ['', '', ''] },
    { title: '   ' },
    { instructions: '\n\n\n' },
    { claimAuthorizer: '  0x1111111111111111111111111111111111111111  ' },
  ];
  for (const over of weird) {
    assert.doesNotThrow(() => derive(form(over), CTX), JSON.stringify(over));
  }
  // whitespace around an address is trimmed, not treated as a typo
  assert.equal(derive(form({ claimAuthorizer: '  0x1111111111111111111111111111111111111111  ' }), CTX).errors.claimAuthorizer, undefined);
  // a huge reward is rejected, not wrapped
  assert.ok(derive(form({ rewardUsdc: '1'.repeat(400) }), CTX).errors.rewardUsdc);
  const nan = derive(form({ workWindowHours: Number.NaN }), CTX);
  assert.ok(nan.errors.workWindowHours);
  assert.equal(nan.ok, false);
  // invalid encodings still produce hex (never throw) so the UI can show a disabled button
  assert.doesNotThrow(() => encodeVerifierInit({ kind: 'onchainCheck', target: '0x1234', calldata: '0x', expectedReturn: '0x', checkWindowSeconds: 0 }));
});
