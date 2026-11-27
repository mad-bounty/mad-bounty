import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Address } from 'viem';
import type { PostDerived, PostFormState, VerifierChoice } from '../../types';
import { CHAINS, buildPostParams, buildSpecJson, defaultForm, derive, describe, duration, usdc, type PostCtx } from '../deps';
import type { SpecPrefill } from '../../model/outcome';
import { createStore, getReader, getWriter, openWalletPicker, runTx, useChain, useStore, useWallet } from '../store';
import { useAsync, useNow } from '../hooks';
import { Btn, Money, Notice } from '../components';
import * as Icon from '../icons';

// Draft survives navigating away (in memory only).
const draft = createStore<PostFormState>(defaultForm());
const posted = createStore<{ id: bigint; chainId: number; title: string } | undefined>(undefined);
/** Set when the wizard was opened from 'Post a similar bounty'. */
const similarFrom = createStore<{ id: bigint; notes: string[] } | undefined>(undefined);

/** Prefill the wizard's task fields from a finished bounty's verified spec (money and reviewer start fresh). */
export function startSimilar(p: SpecPrefill, id: bigint) {
  draft.set({ ...defaultForm(), ...p.fields });
  posted.set(undefined);
  similarFrom.set({ id, notes: p.notes });
}

const STEPS = ['Task', 'Money & rules', 'Review'] as const;
const KB = 1024;

function stepFromHash(): number {
  const m = /[?&]step=(\d)/.exec(location.hash);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 3 ? n : 1;
}
const goStep = (n: number) => { location.hash = n === 1 ? '#/post' : `#/post?step=${n}`; };

export function PostPage() {
  const chain = useChain();
  const w = useWallet();
  const form = useStore(draft);
  const done = useStore(posted);
  const similar = useStore(similarFrom);
  const [step, setStep] = useState(stepFromHash());
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = () => setStep(stepFromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { document.getElementById('wiz-h')?.focus(); }, [step]);
  // The success screen is for this visit only: coming back to the Post tab starts a fresh wizard.
  useEffect(() => () => posted.set(undefined), []);

  const fee = useAsync(() => getReader(chain).feeBps(), [chain]);
  const now = useNow();
  const ctx: PostCtx = useMemo(() => ({ feeBps: fee.data ?? 500n, me: w.address, now, adapters: CHAINS[chain].adapters }), [fee.data, w.address, now, chain]);
  const d = useMemo(() => derive(form, ctx), [form, ctx]);
  const set = (p: Partial<PostFormState>) => draft.set({ ...draft.get(), ...p });
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const specJson = useMemo(() => buildSpecJson(form, ctx), [form, ctx]);
  const specBytes = new TextEncoder().encode(specJson).length;

  const step1Keys = ['title', 'instructions', 'criteria', 'evidenceFormat'] as const;
  const step1Ok = !step1Keys.some((k) => d.errors[k]) && specBytes <= 16 * KB;
  const step2Keys = ['rewardUsdc', 'depositUsdc', 'workWindowHours', 'reviewWindowHours', 'openDays', 'verifier', 'rejectMode', 'claimAuthorizer'] as const;
  const step2Ok = !step2Keys.some((k) => d.errors[k as keyof PostDerived['errors']]);

  const next = (from: number) => {
    const keys = from === 1 ? step1Keys : step2Keys;
    setTouched((t) => ({ ...t, ...Object.fromEntries(keys.map((k) => [k, true])) }));
    if ((from === 1 && step1Ok) || (from === 2 && step2Ok)) goStep(from + 1);
    else setTimeout(() => (document.querySelector('.field.has-err input, .field.has-err textarea, .field.has-err select') as HTMLElement | null)?.focus(), 0);
  };

  const allowance = useAsync(() => (w.address ? getReader(chain).allowance(w.address) : Promise.resolve(0n)), [chain, w.address]);
  const balance = useAsync(() => (w.address ? getReader(chain).usdcBalance(w.address) : Promise.resolve(undefined)), [chain, w.address]);
  const needsApprove = (allowance.data ?? 0n) < d.reward;
  const short = balance.data !== undefined && balance.data < d.reward;

  const submit = async () => {
    if (!w.address) { openWalletPicker(); return; }
    setBusy(true);
    const res = await runTx(chain, `Post “${form.title.slice(0, 40)}”`, async (onP) => {
      const wr = await getWriter(chain);
      // Fresh `now` at signing time; params and spec bytes must come from the same ctx so specHash matches.
      const c: PostCtx = { ...ctx, now: Math.floor(Date.now() / 1000) };
      return wr.post(buildPostParams(form, c), buildSpecJson(form, c), onP);
    });
    setBusy(false);
    if (res !== undefined) { similarFrom.set(undefined); posted.set({ id: res.id, chainId: chain, title: form.title }); draft.set(defaultForm()); setTouched({}); scrollTo(0, 0); }
  };

  if (done) return <PostSuccess id={done.id} title={done.title} onAgain={() => { posted.set(undefined); goStep(1); }} />;

  const err = (k: keyof PostDerived['errors']) => (touched[k] ? d.errors[k] : undefined);

  return (
    <div class="wrap page">
      <div class="phead">
        <div>
          <h1 class="ptitle">Post a bounty</h1>
          <p class="psub">Describe the task, lock the reward in escrow, and let anyone claim it. Takes about two minutes.</p>
        </div>
      </div>

      <ol class="stepper" aria-label="Steps">
        {STEPS.map((s, i) => {
          const n = i + 1; const st = n < step ? 'done' : n === step ? 'now' : 'todo';
          const reachable = n < step || (n === 2 && step1Ok) || (n === 3 && step1Ok && step2Ok);
          return (
            <li class={`st st-${st}`} aria-current={st === 'now' ? 'step' : undefined}>
              <button type="button" disabled={!reachable && st !== 'now'} onClick={() => goStep(n)}>
                <span class="st-n">{st === 'done' ? <Icon.Check size={14} /> : n}</span><span class="st-l">{s}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div class="wiz">
        <div class="wiz-main">
          {step === 1 && (
            <section class="panel" aria-labelledby="wiz-h">
              <h2 class="panel-h" id="wiz-h" tabIndex={-1}>1 · What needs doing?</h2>
              {similar && <Notice tone="info" title={`Copied from bounty #${similar.id}.`}>Edit anything you like — nothing is posted until step 3. {similar.notes.join(' ')} <button type="button" class="linkish" onClick={() => { draft.set(defaultForm()); similarFrom.set(undefined); }}>Start empty</button></Notice>}
              <Field id="title" label="Title" err={err('title')} hint="One line a worker can scan. Shown on the bounty card.">
                <input id="title" value={form.title} maxLength={120} placeholder="e.g. Translate our FAQ into Spanish"
                  onInput={(e) => set({ title: val(e) })} onBlur={() => touch('title')} aria-invalid={!!err('title')} />
              </Field>
              <Field id="summary" label="Summary" optional hint="A sentence of context.">
                <input id="summary" value={form.summary} maxLength={240} onInput={(e) => set({ summary: val(e) })} />
              </Field>
              <Field id="instructions" label="Instructions" err={err('instructions')} hint="Exactly what to do. Be specific — this text is locked once posted.">
                <textarea id="instructions" rows={6} value={form.instructions} onInput={(e) => set({ instructions: val(e) })} onBlur={() => touch('instructions')} aria-invalid={!!err('instructions')} />
              </Field>
              <fieldset class={`field${err('criteria') ? ' has-err' : ''}`}>
                <legend>Accepted if…</legend>
                <p class="hint">Each line is one check the verifier will apply. Clear criteria mean fewer disputes.</p>
                {form.criteria.map((c, i) => (
                  <div class="crit-row">
                    <span class="crit-n" aria-hidden="true">{i + 1}</span>
                    <input aria-label={`Criterion ${i + 1}`} value={c} placeholder={i === 0 ? 'e.g. Every question is translated' : 'Another check'}
                      onInput={(e) => set({ criteria: form.criteria.map((x, j) => (j === i ? val(e) : x)) })} onBlur={() => touch('criteria')} />
                    {form.criteria.length > 1 && (
                      <button type="button" class="icon-btn" aria-label={`Remove criterion ${i + 1}`} onClick={() => set({ criteria: form.criteria.filter((_, j) => j !== i) })}><Icon.Trash size={16} /></button>
                    )}
                  </div>
                ))}
                {form.criteria.length < 12 && <button type="button" class="linkish addc" onClick={() => set({ criteria: [...form.criteria, ''] })}><Icon.Plus size={14} />Add a criterion</button>}
                {err('criteria') && <p class="err" role="alert">{err('criteria')}</p>}
              </fieldset>
              <Field id="evidence" label="What should the worker submit?" err={err('evidenceFormat')} hint="e.g. a public link, a file hash, a transaction id.">
                <input id="evidence" value={form.evidenceFormat} placeholder="A link to a public Google Doc" onInput={(e) => set({ evidenceFormat: val(e) })} onBlur={() => touch('evidenceFormat')} />
              </Field>
              <p class={`bytes${specBytes > 16 * KB ? ' err' : ''}`}>Spec size {(specBytes / KB).toFixed(1)} KB of 16 KB · published on-chain with the bounty so anyone can verify it.</p>
              <div class="wiz-nav"><span /><Btn onClick={() => next(1)}>Continue<Icon.Arrow size={16} /></Btn></div>
            </section>
          )}

          {step === 2 && (
            <section class="panel" aria-labelledby="wiz-h">
              <h2 class="panel-h" id="wiz-h" tabIndex={-1}>2 · Money &amp; rules</h2>
              <MoneyFields form={form} d={d} set={set} err={err} touch={touch} />
              <VerifierPicker form={form} set={set} err={err('verifier')} me={w.address} />
              <RejectMode form={form} set={set} d={d} />
              <div class="wiz-nav"><Btn kind="quiet" onClick={() => goStep(1)}><Icon.Back size={16} />Back</Btn><Btn onClick={() => next(2)}>Review<Icon.Arrow size={16} /></Btn></div>
            </section>
          )}

          {step === 3 && (
            <section class="panel" aria-labelledby="wiz-h">
              <h2 class="panel-h" id="wiz-h" tabIndex={-1}>3 · Check and post</h2>
              <div class="review-title">
                <span class="k">Task</span>
                <strong>{form.title || 'Untitled'}</strong>
                <span class="muted small">{form.criteria.filter((c) => c.trim()).length} acceptance criteria · verifier: {verifierText(form.verifier)}</span>
              </div>
              <h3 class="spec-sub">In plain words</h3>
              <ol class="describe">{describe(form, d, ctx).map((l) => <li>{l}</li>)}</ol>
              {d.warnings.map((x) => <Notice tone="danger" title="Heads up.">{plainWarn(x)}</Notice>)}
              {short && <Notice tone="warn" title="Not enough USDC.">Your wallet holds {usdc(balance.data!)} USDC; this bounty needs {usdc(d.reward)} USDC.</Notice>}
              {!d.ok && <Notice tone="warn" title="Something is missing.">{Object.values(d.errors)[0]} <button type="button" class="linkish" onClick={() => goStep(d.errors.title || d.errors.instructions || d.errors.criteria ? 1 : 2)}>Fix it</button></Notice>}
              <div class="txplan">
                <h3 class="spec-sub">What your wallet will ask</h3>
                <ol>
                  {w.address && needsApprove && <li><span class="tp-n">1</span><span>Allow the MAD Bounty contract to move <strong>{usdc(d.reward)} USDC</strong> (exact amount, not unlimited).</span></li>}
                  <li><span class="tp-n">{w.address && needsApprove ? 2 : 1}</span><span>Post the bounty — moves <strong>{usdc(d.reward)} USDC</strong> into its escrow vault.</span></li>
                </ol>
              </div>
              <p class="audit-line audit-near"><Icon.Alert size={14} /><span><strong>NOT externally audited</strong> — only escrow what you can afford to lose. Contracts are immutable. Network: <strong>{CHAINS[chain].name}</strong>.</span></p>
              <div class="wiz-nav wiz-nav-tight">
                <Btn kind="quiet" onClick={() => goStep(2)}><Icon.Back size={16} />Back</Btn>
                {w.address
                  ? <Btn size="lg" busy={busy} disabled={!d.ok || short} onClick={submit}>{needsApprove ? 'Approve & post' : 'Post'} · <span class="nowrap">{usdc(d.reward)} USDC</span></Btn>
                  : <Btn size="lg" onClick={openWalletPicker}><Icon.Wallet size={18} />Connect wallet to post</Btn>}
              </div>
              {w.address && (short || !d.ok) && <p class="why-off small post-why">{short ? `Needs ${usdc(d.reward)} USDC; your wallet holds ${usdc(balance.data!)} USDC.` : 'Fix the issue above to post.'}</p>}
            </section>
          )}
        </div>
        <aside class="wiz-side" aria-label="Payout preview"><PayoutPanel form={form} d={d} /></aside>
      </div>
    </div>
  );
}

const val = (e: Event) => (e.target as HTMLInputElement).value;
/** Domain warnings may carry internal audit codes ("A6: …"); users don't need them. */
const plainWarn = (w: string) => w.replace(/^\s*[A-Z]\d+[a-z]?:\s*/, '');

function Field({ id, label, hint, err, optional, children }: { id: string; label: string; hint?: string; err?: string; optional?: boolean; children: preact.ComponentChildren }) {
  return (
    <div class={`field${err ? ' has-err' : ''}`}>
      <label for={id}>{label}{optional && <span class="opt">optional</span>}</label>
      {children}
      {err ? <p class="err" id={`${id}-err`} role="alert">{err}</p> : hint ? <p class="hint">{hint}</p> : null}
    </div>
  );
}

function MoneyFields({ form, d, set, err, touch }: { form: PostFormState; d: PostDerived; set: (p: Partial<PostFormState>) => void; err: (k: keyof PostDerived['errors']) => string | undefined; touch: (k: string) => void }) {
  const depositNum = Number(d.deposit) / 1e6;
  const minNum = Number(d.minDeposit) / 1e6;
  const maxNum = Math.max(minNum, Number(d.reward) / 1e6);
  return (
    <>
      <div class="grid2">
        <Field id="reward" label="Reward" err={err('rewardUsdc')} hint="1 to 1,000 USDC. Locked in escrow when you post.">
          <div class="affix"><input id="reward" inputMode="decimal" value={form.rewardUsdc} onInput={(e) => set({ rewardUsdc: val(e).replace(/[^0-9.]/g, '') })} onBlur={() => touch('rewardUsdc')} aria-invalid={!!err('rewardUsdc')} /><span>USDC</span></div>
        </Field>
        <Field id="deposit" label="Worker deposit" err={err('depositUsdc')} hint={`Minimum ${usdc(d.minDeposit)} USDC. Higher keeps out low-effort claims.`}>
          <div class="affix"><input id="deposit" inputMode="decimal" value={form.depositUsdc === '' ? usdc(d.minDeposit).replace(/,/g, '') : form.depositUsdc} onInput={(e) => set({ depositUsdc: val(e).replace(/[^0-9.]/g, '') })} onBlur={() => touch('depositUsdc')} aria-invalid={!!err('depositUsdc')} /><span>USDC</span></div>
        </Field>
      </div>
      {d.reward > 0n && (
        <div class="slider">
          <input type="range" aria-label="Deposit size" min={minNum} max={maxNum} step={Math.max(0.01, (maxNum - minNum) / 100)} value={Math.min(depositNum, maxNum)}
            onInput={(e) => set({ depositUsdc: Number(val(e)).toFixed(2) })} />
          <div class="slider-l"><span>Min {usdc(d.minDeposit)}</span><span>{Math.round((depositNum / Math.max(d.reward ? Number(d.reward) / 1e6 : maxNum, 1e-9)) * 100)}% of reward (min 2%)</span><span>Max {usdc(d.reward)}</span></div>
        </div>
      )}
      <div class="grid3">
        <Field id="work" label="Time to do the work" hint="After claiming.">
          <select id="work" value={form.workWindowHours} onChange={(e) => set({ workWindowHours: Number(val(e)) })}>
            {[1, 6, 12, 24, 48, 72, 168, 336, 720].map((h) => <option value={h}>{duration(h * 3600)}</option>)}
          </select>
        </Field>
        <Field id="review" label="Time to review" hint="If you don't decide in time, the worker is paid automatically.">
          <select id="review" value={form.reviewWindowHours} onChange={(e) => set({ reviewWindowHours: Number(val(e)) })}>
            {[12, 24, 48, 72, 168, 336, 720].map((h) => <option value={h}>{duration(h * 3600)}</option>)}
          </select>
        </Field>
        <Field id="open" label="Open for claims" hint="If nobody claims it by then, the reward can be returned to you.">
          <select id="open" value={form.openDays} onChange={(e) => set({ openDays: Number(val(e)) })}>
            {[1, 3, 7, 14, 30, 60, 90, 180].map((n) => <option value={n}>{n} {n === 1 ? 'day' : 'days'}</option>)}
          </select>
        </Field>
      </div>
    </>
  );
}

function verifierText(v: VerifierChoice) {
  switch (v.kind) {
    case 'self': return 'you';
    case 'address': return 'another address';
    case 'multi': return `${v.threshold} of ${v.signers.length} reviewers`;
    case 'fallback': return 'fallback ladder';
    case 'hashReveal': return 'hash reveal';
    case 'onchainCheck': return 'on-chain check';
    case 'teeML': return 'AI judge (0G TeeML)';
  }
}

const SIMPLE: { kind: VerifierChoice['kind']; t: string; d: string; make: () => VerifierChoice }[] = [
  { kind: 'self', t: "I'll review it myself", d: 'Your connected wallet accepts or rejects. Simplest. Workers will see you judge your own bounty.', make: () => ({ kind: 'self' }) },
  { kind: 'address', t: 'Someone else reviews', d: 'A person or bot you name gives the verdict.', make: () => ({ kind: 'address', address: '' }) },
  { kind: 'multi', t: 'A panel votes', d: 'Several reviewers; a majority you choose decides. Harder to game.', make: () => ({ kind: 'multi', signers: ['', '', ''], threshold: 2 }) },
];
const ADVANCED: { kind: VerifierChoice['kind']; t: string; d: string; make: () => VerifierChoice }[] = [
  { kind: 'onchainCheck', t: 'On-chain check', d: 'A contract call decides: pass if it returns the expected value.', make: () => ({ kind: 'onchainCheck', target: '', calldata: '0x', expectedReturn: '0x', checkWindowSeconds: 3600 }) },
  { kind: 'hashReveal', t: 'Hash reveal', d: 'You commit to a secret answer; the worker must find it.', make: () => ({ kind: 'hashReveal', answer: '', salt: '', revealWindowSeconds: 3600 }) },
  { kind: 'teeML', t: 'AI judge (0G TeeML)', d: 'A model in a secure enclave grades the evidence against your rubric.', make: () => ({ kind: 'teeML', enclaveSigners: [''], promptPrefix: '', promptSuffix: '', windowSeconds: 3600 }) },
  { kind: 'fallback', t: 'Fallback ladder', d: 'Reviewers in order; if one is silent, the next gets a turn.', make: () => ({ kind: 'fallback', signers: ['', ''], stepSeconds: 6 * 3600 }) },
];

function VerifierPicker({ form, set, err, me }: { form: PostFormState; set: (p: Partial<PostFormState>) => void; err?: string; me?: Address }) {
  const v = form.verifier;
  const isAdv = ADVANCED.some((a) => a.kind === v.kind);
  const [adv, setAdv] = useState(isAdv);
  const opt = (o: typeof SIMPLE[number]) => (
    <label class={`vopt${v.kind === o.kind ? ' on' : ''}`}>
      <input type="radio" name="verifier" checked={v.kind === o.kind} onChange={() => set({ verifier: o.make() })} />
      <span class="vopt-b"><span class="vopt-t">{o.t}</span><span class="vopt-d">{o.d}</span></span>
    </label>
  );
  const upd = (p: Partial<VerifierChoice>) => set({ verifier: { ...v, ...p } as VerifierChoice });
  const list = (key: 'signers' | 'enclaveSigners', label: string) => {
    const arr = (v as Record<string, unknown>)[key] as string[];
    return (
      <div class="field">
        <span class="lbl">{label}</span>
        {arr.map((s, i) => (
          <div class="crit-row">
            <span class="crit-n">{i + 1}</span>
            <input class="mono" aria-label={`${label} ${i + 1}`} placeholder="0x…" value={s} onInput={(e) => upd({ [key]: arr.map((x, j) => (j === i ? val(e) : x)) } as never)} />
            {arr.length > 1 && <button type="button" class="icon-btn" aria-label={`Remove ${i + 1}`} onClick={() => upd({ [key]: arr.filter((_, j) => j !== i) } as never)}><Icon.Trash size={16} /></button>}
          </div>
        ))}
        {arr.length < 9 && <button type="button" class="linkish addc" onClick={() => upd({ [key]: [...arr, ''] } as never)}><Icon.Plus size={14} />Add</button>}
      </div>
    );
  };
  return (
    <fieldset class={`field vpick${err ? ' has-err' : ''}`}>
      <legend>Who decides if the work is good?</legend>
      <div class="vopts">{SIMPLE.map(opt)}</div>
      <details class="adv" open={adv} onToggle={(e) => setAdv((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced: automatic verifiers</summary>
        <div class="vopts">{ADVANCED.map(opt)}</div>
      </details>

      <div class="vcfg">
        {v.kind === 'self' && <p class="hint">{me ? <>Verdicts will come from <span class="mono">{me.slice(0, 6)}…{me.slice(-4)}</span>.</> : 'Connect a wallet — it becomes the reviewer.'}</p>}
        {v.kind === 'address' && (
          <div class="field"><label for="vaddr">Reviewer address</label>
            <input id="vaddr" class="mono" placeholder="0x…" value={v.address} onInput={(e) => upd({ address: val(e).trim() })} /></div>
        )}
        {v.kind === 'multi' && (<>
          {list('signers', 'Reviewer')}
          <div class="field"><label for="thr">Votes needed</label>
            <select id="thr" value={v.threshold} onChange={(e) => upd({ threshold: Number(val(e)) })}>
              {v.signers.map((_, i) => <option value={i + 1}>{i + 1} of {v.signers.length}</option>)}
            </select></div>
        </>)}
        {v.kind === 'fallback' && (<>
          {list('signers', 'Reviewer (in order)')}
          <div class="field"><label for="step">Each reviewer's turn</label>
            <select id="step" value={v.stepSeconds} onChange={(e) => upd({ stepSeconds: Number(val(e)) })}>
              {[3600, 6 * 3600, 12 * 3600, 86400].map((s) => <option value={s}>{duration(s)}</option>)}
            </select></div>
        </>)}
        {v.kind === 'hashReveal' && (<>
          <div class="field"><label for="hr-a">Secret answer</label><input id="hr-a" value={v.answer} onInput={(e) => upd({ answer: val(e) })} />
            <p class="hint">Only its salted hash goes on-chain. Short or guessable answers can be brute-forced — use something with real entropy.</p></div>
          <div class="field"><label for="hr-s">Salt</label><input id="hr-s" class="mono" value={v.salt} onInput={(e) => upd({ salt: val(e) })} placeholder="random text — keep a copy" /></div>
        </>)}
        {v.kind === 'onchainCheck' && (<>
          <div class="field"><label for="oc-t">Contract to call</label><input id="oc-t" class="mono" placeholder="0x…" value={v.target} onInput={(e) => upd({ target: val(e).trim() })} /></div>
          <div class="field"><label for="oc-c">Calldata</label><input id="oc-c" class="mono" value={v.calldata} onInput={(e) => upd({ calldata: val(e).trim() })} /></div>
          <div class="field"><label for="oc-e">Expected return</label><input id="oc-e" class="mono" value={v.expectedReturn} onInput={(e) => upd({ expectedReturn: val(e).trim() })} />
            <p class="hint">If anyone can make this check false after the worker delivers, they can burn the worker's deposit. Pick a check only the worker's delivery changes.</p></div>
        </>)}
        {v.kind === 'teeML' && (<>
          {list('enclaveSigners', 'Enclave signer')}
          <div class="field"><label for="tm-p">Rubric (prompt before the evidence)</label><textarea id="tm-p" rows={3} value={v.promptPrefix} onInput={(e) => upd({ promptPrefix: val(e) })} /></div>
          <div class="field"><label for="tm-s">Prompt after the evidence</label><textarea id="tm-s" rows={2} value={v.promptSuffix} onInput={(e) => upd({ promptSuffix: val(e) })} />
            <p class="hint">Workers need this exact text to check the bounty is fair. Publish it in the instructions.</p></div>
        </>)}
        {err && <p class="err" role="alert">{err}</p>}
      </div>
    </fieldset>
  );
}

function RejectMode({ form, set, d }: { form: PostFormState; set: (p: Partial<PostFormState>) => void; d: PostDerived }) {
  return (
    <fieldset class="field">
      <legend>If you reject the work</legend>
      <div class="vopts vopts-2">
        <label class={`vopt${form.rejectMode === 'Burn' ? ' on' : ''}`}>
          <input type="radio" name="rm" checked={form.rejectMode === 'Burn'} onChange={() => set({ rejectMode: 'Burn' })} />
          <span class="vopt-b"><span class="vopt-t">Burn it <span class="chip chip-plain">recommended</span></span><span class="vopt-d">Reward and deposit are destroyed. You can't profit from rejecting good work, so workers trust you.</span></span>
        </label>
        <label class={`vopt vopt-warn${form.rejectMode === 'Refund' ? ' on' : ''}`}>
          <input type="radio" name="rm" checked={form.rejectMode === 'Refund'} onChange={() => set({ rejectMode: 'Refund' })} />
          <span class="vopt-b"><span class="vopt-t">Refund me</span><span class="vopt-d">Reward comes back to you; the worker's deposit burns. Only fair with an independent verifier.</span></span>
        </label>
      </div>
      {form.rejectMode === 'Refund' && (
        <Notice tone="danger" title="REFUND needs a verifier you don't control.">
          {(d.warnings[0] && plainWarn(d.warnings[0])) || 'With REFUND, whoever controls the verdict can keep the work and get the money back. Workers\' safety checks flag REFUND bounties without an independent verifier as dangerous.'}
        </Notice>
      )}
    </fieldset>
  );
}

function PayoutPanel({ form, d }: { form: PostFormState; d: PostDerived }) {
  const pct = Number(d.feeBps) / 100;
  return (
    <div class="payout" aria-live="polite">
      <span class="payout-k">You lock now</span>
      <div class="payout-hero"><Money v={d.reward} size="hero" /></div>
      <dl class="payout-l">
        <div><dt>Worker deposit (theirs)</dt><dd>{usdc(d.deposit)} USDC</dd></div>
        <div><dt>Fee ({pct}%, taken on payout)</dt><dd>{usdc(d.fee)} USDC</dd></div>
      </dl>
      <div class="payout-o">
        <div class="po po-pos"><span class="po-k"><Icon.Check size={14} />Accepted or verifier silent</span><span class="po-v">Worker gets <strong>{usdc(d.workerGetsOnAccept)}</strong> USDC</span></div>
        <div class="po po-neg"><span class="po-k"><Icon.Flame size={14} />Rejected</span>
          <span class="po-v">{form.rejectMode === 'Burn' ? <><strong>{usdc(d.burnedOnReject)}</strong> USDC burns, you get 0</> : <>You get <strong>{usdc(d.agentBackOnReject)}</strong> back, <strong>{usdc(d.burnedOnReject)}</strong> burns</>}</span></div>
        <div class="po"><span class="po-k"><Icon.Clock size={14} />Nobody claims in {form.openDays}d</span><span class="po-v">You get <strong>{usdc(d.reward)}</strong> USDC back</span></div>
      </div>
    </div>
  );
}

function PostSuccess({ id, title, onAgain }: { id: bigint; title: string; onAgain: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}${location.pathname}#/bounty/${id}`;
  const share = `New bounty on MAD Bounty: “${title}” — ${url}`;
  return (
    <div class="wrap page">
      <div class="success">
        <div class="success-ic" aria-hidden="true"><Icon.Check size={30} /></div>
        <h1 class="ptitle">Bounty #{id.toString()} is live</h1>
        <p class="psub">The reward is in escrow. Workers can claim it now.</p>
        <div class="share">
          <code>{share}</code>
          <Btn kind="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(share); setCopied(true); } catch { /* */ } }}>{copied ? <><Icon.Check size={14} />Copied</> : <><Icon.Copy size={14} />Copy</>}</Btn>
        </div>
        <div class="success-a">
          <Btn href={`#/bounty/${id}`} size="lg">Open the bounty<Icon.Arrow size={16} /></Btn>
          <Btn kind="ghost" onClick={onAgain}>Post another</Btn>
        </div>
      </div>
    </div>
  );
}
