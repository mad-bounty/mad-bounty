// Bounty building blocks: card, money box, timeline, spec view, parties.
import { useState } from 'preact/hooks';
import type { Address } from 'viem';
import type { BountySummary, BountyView, SpecStatus, TimelineEvent, TimelineKind } from '../types';
import { duration, eventDetail, feeLabel, gapLabel, moneyRows, moneyView, outcomeOf, specHashOf, usdc, utc, verifierKindLabel, type MoneyRow, type Path, type RowAmount } from './deps';
import { Addr, CopyBtn, Countdown, KindChip, Money, Notice, Skeleton, StatePill, TxLink, When } from './components';
import * as Icon from './icons';

const ZERO = '0x0000000000000000000000000000000000000000';
export const eqAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const isZero = (a?: string) => !a || a.toLowerCase() === ZERO;

/** The deadline a card should count down to, with a plain label. */
export function cardClock(b: Pick<BountySummary, 'state' | 'openUntil' | 'deadline'>): { to: number; label: string } | undefined {
  if (b.state === 'Open') return { to: Number(b.openUntil), label: 'to claim' };
  if (b.state === 'Claimed') return { to: Number(b.deadline), label: 'to submit' };
  if (b.state === 'Submitted') return { to: Number(b.deadline), label: 'to review' };
  if (b.state === 'Rejected') return { to: Number(b.deadline), label: 'until burn' };
  return undefined;
}

// ---------------------------------------------------------------- BountyCard
export function BountyCard({ b, me }: { b: BountySummary; me?: Address }) {
  const clock = cardClock(b);
  const done = ['Paid', 'Burned', 'Refunded', 'Cancelled'].includes(b.state);
  const generic = b.title.trim() === `Bounty #${b.id}`;
  const role = eqAddr(me, b.agent) ? 'You posted' : eqAddr(me, b.worker) ? (done ? 'You worked on it' : 'You\'re working') : eqAddr(me, b.verifier) ? (done ? 'You reviewed' : 'You review') : undefined;
  return (
    <a class={`bcard${done ? ' is-done' : ''}`} href={`#/bounty/${b.id}`} aria-label={`${b.title}, reward ${usdc(b.reward)} USDC, ${b.state}`}>
      <div class="bc-top">
        <StatePill state={b.state} />
        {!generic && <span class="bc-id mono">#{b.id.toString()}</span>}
      </div>
      <h3 class="bc-title">{b.title}</h3>
      <div class="bc-reward"><Money v={b.reward} size="lg" /></div>
      <div class="bc-meta">
        <KindChip kind={b.verifierKind} />
        {b.state === 'Open' && <span class="chip chip-plain">Deposit {usdc(b.deposit)} USDC</span>}
        {b.rejectMode === 'Refund' && <span class="chip chip-warn" title="On reject the reward returns to the poster">Refund on reject</span>}
        {role && <span class="chip chip-you">{role}</span>}
      </div>
      <div class="bc-foot">
        {clock && !done ? <Countdown to={clock.to} label={clock.label} /> : <span class="muted small">Posted <When t={b.postedAt} /></span>}
        <span class="bc-go" aria-hidden="true"><Icon.Arrow size={16} /></span>
      </div>
    </a>
  );
}

// ---------------------------------------------------------------- MoneyBox
const TERMINAL_STATES = ['Paid', 'Burned', 'Refunded', 'Cancelled'];
export const isTerminal = (state: string) => TERMINAL_STATES.includes(state);
/** Which money-table row a finished bounty realised. */
const ROW_OF: Partial<Record<Path, MoneyRow['id']>> = { accept: 'accept', timeout: 'timeout', burn: 'reject', refund: 'reject' };

function signed(n: bigint): string {
  return n > 0n ? `+${usdc(n)}` : n < 0n ? `−${usdc(-n)}` : usdc(0n);
}
function MoneyCell({ c, who }: { c: RowAmount | null; who: string }) {
  if (!c) return <td class="mb-neu" data-label={who}><span class="mb-t">—</span></td>;
  const tone = c.net > 0n ? 'pos' : c.net < 0n ? 'neg' : 'neu';
  const w = c.wallet;
  return (
    <td class={`mb-${tone}`} data-label={who}>
      <span class="mb-amt">{signed(c.net)}</span><span class="mb-u"> USDC</span>
      <span class="mb-t">{c.note}</span>
      {w && w.dir === 'in' && w.of !== undefined && <span class="mb-g">gets {usdc(w.amount)} back <span class="nowrap">({usdc(w.of)} deposit + {usdc(w.amount - w.of)})</span></span>}
    </td>
  );
}

export function MoneyBox({ v, me }: { v: BountyView; me?: Address }) {
  const b = v.bounty;
  const rows = moneyRows(moneyView(b));
  const fee = rows[0]!.treasury;
  const done = isTerminal(b.state);
  const out = done ? outcomeOf(v.timeline, b.id) : undefined;
  const realized = out ? ROW_OF[out.path] : undefined;
  const youW = eqAddr(me, b.worker) || (b.state === 'Open' && !!me && !eqAddr(me, b.agent));
  const youA = eqAddr(me, b.agent);
  return (
    <section class={`panel${done ? ' mb-done' : ''}`} aria-labelledby="mb-h">
      <h2 class="panel-h" id="mb-h"><Icon.Coins size={18} />Who gets what</h2>
      <div class="mb-in">
        <div><span class="k">Reward</span><Money v={b.reward} /></div>
        <div><span class="k">Worker deposit</span><Money v={b.deposit} /></div>
        <div><span class="k">Protocol fee</span><Money v={fee} /><span class="mb-kx">{feeLabel(b.feeBps)}</span></div>
      </div>
      {done && !realized && out && <p class="mb-note">{out.word}: none of these happened — nobody claimed it, and the reward went back to the poster.</p>}
      <table class="mbox">
        <caption class="sr">Net change in USDC for each party, per outcome</caption>
        <thead><tr><th scope="col">If…</th><th scope="col">Worker{youW ? ' (you)' : ''}</th><th scope="col">Poster{youA ? ' (you)' : ''}</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const hit = realized === r.id;
            const foot = [r.treasury > 0n ? `${usdc(r.treasury)} fee to treasury` : '', r.burned > 0n ? `${usdc(r.burned)} burned` : ''].filter(Boolean).join(' · ');
            return (
              <tr class={hit ? `mb-hit${out?.path === 'burn' || out?.path === 'refund' ? ' mb-hit-neg' : ''}` : done ? 'mb-dim' : ''} aria-current={hit ? 'true' : undefined}>
                <th scope="row">
                  {hit && <span class="mb-tag"><Icon.Check size={12} />What happened</span>}
                  {r.label}
                  <span class="mb-hint">{r.hint}</span>
                  {foot && <span class="mb-foot">+ {foot}</span>}
                </th>
                <MoneyCell c={r.worker} who={youW ? 'Worker (you)' : 'Worker'} />
                <MoneyCell c={r.poster} who={youA ? 'Poster (you)' : 'Poster'} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="mb-fine">Numbers are each party's <strong>net</strong> change. In every row, worker + poster + fee + burned adds up to zero.</p>
    </section>
  );
}

// ---------------------------------------------------------------- Parties
export function Parties({ v, me }: { v: BountyView; me?: Address }) {
  const b = v.bounty;
  const row = (k: string, a: string, note?: string) => (
    <div class="party"><span class="k">{k}</span><span class="v">{isZero(a) ? <span class="muted">{note ?? 'Nobody yet'}</span> : <Addr a={a} label={k} you={eqAddr(me, a)} />}</span></div>
  );
  return (
    <section class="panel" aria-labelledby="pt-h">
      <h2 class="panel-h" id="pt-h"><Icon.User size={18} />People &amp; rules</h2>
      {row('Poster', b.agent)}
      {row('Worker', b.worker, 'Not claimed yet')}
      <div class="party">
        <span class="k">Verifier</span>
        <span class="v">{eqAddr(b.verifier, b.agent) ? <span class="vself"><Addr a={b.verifier} label="verifier" you={eqAddr(me, b.verifier)} /><span class="muted small">the poster</span></span> : <Addr a={b.verifier} label="verifier" you={eqAddr(me, b.verifier)} />}</span>
      </div>
      <div class="party"><span class="k">Verdict by</span><span class="v">{verifierKindLabel(v.verifierKind)}</span></div>
      <div class="party"><span class="k">On reject</span><span class="v">{b.rejectMode === 'Refund' ? <span class="t-gold">Reward back to poster, deposit burns</span> : 'Reward + deposit burn'}</span></div>
      <div class="party"><span class="k">Cooling-off</span><span class="v">24h after a reject, before it is final</span></div>
      <div class="party"><span class="k">Windows</span><span class="v">{duration(b.workWindow)} to work · {duration(b.reviewWindow)} to review</span></div>
      {!isZero(b.claimAuthorizer) && row('Claim approver', b.claimAuthorizer)}
      <div class="party"><span class="k">Vault</span><span class="v"><Addr a={b.vault} label="vault" /> <span class="muted small">holds {usdc(v.vaultBalance)} USDC</span></span></div>
    </section>
  );
}

// ---------------------------------------------------------------- Timeline
const TL: Record<TimelineKind, string> = {
  Posted: 'Posted', Cancelled: 'Cancelled by poster', Expired: 'Expired — nobody claimed',
  Claimed: 'Claimed', Submitted: 'Work submitted', ReviewExtended: 'Review extended',
  Rejected: 'Rejected', Reversed: 'Rejection reversed', Paid: 'Worker paid',
  Burned: 'Funds burned', Refunded: 'Refunded to poster', Abandoned: 'Abandoned · reopened',
  Owed: 'Payment queued', Withdrawn: 'Withdrawn',
};
/** Outcome-coloured events; everything else that already happened shares one 'done' style. */
const TL_TONE: Partial<Record<TimelineKind, string>> = {
  Paid: 'green', Withdrawn: 'green', Reversed: 'green', Burned: 'danger', Rejected: 'danger', Abandoned: 'danger', Cancelled: 'muted', Expired: 'muted', Refunded: 'muted',
};
function tlLabel(e: TimelineEvent): string {
  if (e.kind === 'Paid') return e.args.byTimeout === true ? 'Paid on timeout' : 'Accepted · worker paid';
  return TL[e.kind];
}
/** '2026-11-27 08:55:12 UTC' — seconds matter when two steps land in the same minute. */
const utcSec = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
export function Timeline({ v, next }: { v: BountyView; next?: { headline: string; deadline?: number } }) {
  const b = v.bounty;
  const events = v.timeline;
  const ctx = { reward: b.reward, deposit: b.deposit, feeBps: b.feeBps, verifier: b.verifier };
  return (
    <section class="panel" aria-labelledby="tl-h">
      <h2 class="panel-h" id="tl-h"><Icon.Clock size={18} />Timeline</h2>
      <ol class="tl">
        {events.map((e, i) => {
          const d = eventDetail(e, ctx);
          const prev = i > 0 ? events[i - 1] : undefined;
          const gap = prev && e.time && prev.time ? gapLabel(prev.time, e.time, prev.kind) : '';
          return (
            <li class={`tl-i tl-done tone-${TL_TONE[e.kind] ?? 'accent'}`}>
              <span class="tl-dot" aria-hidden="true" />
              <div class="tl-b">
                <span class="tl-l">{tlLabel(e)}</span>
                {d && <span class="tl-d">{d}</span>}
                <span class="tl-m">
                  {e.time ? <><time dateTime={new Date(e.time * 1000).toISOString()}>{utcSec(e.time)}</time><span> · <When t={e.time} /></span></> : null}
                  {gap && <span class="tl-gap"> · {gap}</span>}
                </span>
                <TxLink hash={e.tx} label={`View transaction for ${tlLabel(e)}`}>View tx</TxLink>
              </div>
            </li>
          );
        })}
        {next && (
          <li class="tl-i tl-next">
            <span class="tl-dot" aria-hidden="true" />
            <div class="tl-b"><span class="tl-l">Next: {next.headline}</span>{next.deadline ? <span class="tl-m">deadline {utc(next.deadline)} · <When t={next.deadline} /></span> : null}</div>
          </li>
        )}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- SpecView
/** Plain text with `inline code` spans. No HTML is ever injected. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return <>{parts.map((p) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code>{p.slice(1, -1)}</code> : p))}</>;
}
function renderEvidence(f: unknown): string {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') {
    const o = f as Record<string, unknown>;
    if (typeof o.description === 'string') return o.description;
    try { return JSON.stringify(f, null, 2); } catch { return ''; }
  }
  return '';
}
/** Paste-and-compare: keccak256 of the exact UTF-8 bytes typed, no trimming or canonicalising. */
function SpecCheck({ specHash }: { specHash: string }) {
  const [text, setText] = useState('');
  const h = text ? specHashOf(text) : undefined;
  const ok = !!h && h.toLowerCase() === specHash.toLowerCase();
  return (
    <details class="speccheck">
      <summary>Check a spec</summary>
      <div class="field">
        <label for="spec-paste">Paste the exact spec text the poster sent you</label>
        <textarea id="spec-paste" class="mono" rows={5} spellcheck={false} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder='{"specVersion":"madb-spec/1", …}' />
        <p class="hint"><Icon.Info size={14} />Hashed in your browser, byte for byte. A single changed space or line ending gives a different hash.</p>
      </div>
      {h && (
        <div class={`sc-res ${ok ? 'sc-ok' : 'sc-bad'}`} role="status">
          {ok ? <Icon.ShieldCheck size={16} /> : <Icon.Alert size={16} />}
          <span><strong>{ok ? 'Match.' : 'No match.'}</strong> {ok ? 'This is the text the bounty committed to.' : 'This is not the text the bounty committed to — don\'t rely on it.'}<code class="mono sc-h">{h}</code></span>
        </div>
      )}
    </details>
  );
}

export function SpecView({ s, specHash, open = true }: { s: SpecStatus; specHash: string; open?: boolean }) {
  if (s.kind === 'loading') {
    return <section class="panel"><Skeleton h={14} w="40%" /><div style={{ height: '12px' }} /><Skeleton h={14} /><Skeleton h={14} w="90%" /><Skeleton h={14} w="70%" /></section>;
  }
  if (s.kind !== 'verified') {
    return (
      <section class="panel" aria-labelledby="sp-h">
        <h2 class="panel-h" id="sp-h"><Icon.Doc size={18} />The task</h2>
        {s.kind === 'mismatch' && <Notice tone="danger" title="Spec doesn't match.">The text found in the post transaction does not hash to the on-chain specHash. Don't rely on it — ask the poster for the real spec.</Notice>}
        {s.kind === 'offchain' && <Notice tone="info" title="Spec not on-chain.">The task text was published off-chain. Ask the poster for it, then check its keccak256 matches:{open ? ' do this before you claim.' : ''}</Notice>}
        {s.kind === 'invalid' && <Notice tone="warn" title="Spec can't be read.">{s.reason}</Notice>}
        <div class="hashline"><span class="k">specHash</span><span class="hash-row"><code class="mono">{specHash}</code><CopyBtn text={specHash} label="specHash" /></span></div>
        {s.kind !== 'invalid' && <SpecCheck specHash={specHash} />}
      </section>
    );
  }
  const sp = s.spec;
  const ev = renderEvidence(sp.evidenceFormat);
  return (
    <section class="panel spec" aria-labelledby="sp-h">
      <div class="spec-head">
        <h2 class="panel-h" id="sp-h"><Icon.Doc size={18} />The task</h2>
        <span class="verified" title={`keccak256 of ${s.bytes} bytes in the post transaction equals specHash ${specHash}`}><Icon.ShieldCheck size={15} />Verified on-chain</span>
      </div>
      {sp.summary && <p class="spec-sum">{sp.summary}</p>}
      <h3 class="spec-sub">Instructions</h3>
      <div class="spec-text"><Rich text={sp.instructions} /></div>
      {sp.acceptanceCriteria?.length > 0 && (
        <>
          <h3 class="spec-sub">Accepted if</h3>
          <ul class="criteria">
            {sp.acceptanceCriteria.map((c) => (
              <li><span class="crit-ic" aria-hidden="true"><Icon.Check size={14} /></span><span><Rich text={c.description} /></span>{c.required === false && <span class="chip chip-plain">optional</span>}</li>
            ))}
          </ul>
        </>
      )}
      {ev && (<><h3 class="spec-sub">Evidence to submit</h3><div class="spec-text spec-ev">{ev}</div></>)}
    </section>
  );
}

export function BountyHeader({ v }: { v: BountyView }) {
  const b = v.bounty;
  const clock = cardClock(b);
  const done = isTerminal(b.state);
  const out = done ? outcomeOf(v.timeline, b.id) : undefined;
  const genericTitle = v.title.trim() === `Bounty #${b.id}`;
  const fee = moneyRows(moneyView(b))[0]!.treasury;
  return (
    <div class="bhead">
      <div class="bhead-top">
        <a class="back" href="#/"><Icon.Back size={16} />All bounties</a>
      </div>
      <div class="bhead-pills"><StatePill state={b.state} /><KindChip kind={v.verifierKind} />{!genericTitle && <span class="bc-id mono">#{b.id.toString()}</span>}</div>
      <h1 class="bhead-t">{v.title}</h1>
      {out && out.path !== 'none' ? (
        <div class={`bhead-out out-${out.path}`}>
          <span class="bo-k">{out.word}</span>
          <div class="bhead-reward">
            <Money v={out.amount ?? b.reward} size="hero" />
            <span class="bo-to">{out.path === 'accept' || out.path === 'timeout'
              ? <>paid out to {out.to ? <Addr a={out.to} label="worker" /> : 'the worker'} <span class="t-dim">(incl. their deposit back)</span></>
              : out.to}</span>
          </div>
          <p class="bhead-sub">
            {(out.path === 'accept' || out.path === 'timeout')
              ? <>{usdc(b.reward)} reward − {usdc(fee)} fee + {usdc(b.deposit)} deposit back · <strong class="t-green nowrap">+{usdc(b.reward - fee)} USDC net</strong> to the worker</>
              : out.path === 'burn' ? <>{usdc(b.reward)} reward + {usdc(b.deposit)} worker deposit</>
                : <>{usdc(b.reward)} USDC reward</>}
          </p>
        </div>
      ) : (
        <div class="bhead-reward">
          <Money v={b.reward} size="hero" />
          <span class="bhead-sub">reward{b.state === 'Open' ? <> · claim with a <strong>{usdc(b.deposit)} USDC</strong> deposit</> : null}</span>
        </div>
      )}
      <div class="bhead-meta">
        {clock && !done && <Countdown to={clock.to} label={clock.label} />}
        <span class="muted small">
          {done && v.timeline.length > 0 && v.timeline[v.timeline.length - 1]!.time > 0 && <>Finished <When t={v.timeline[v.timeline.length - 1]!.time} /> · </>}
          Posted <When t={v.postedAt} />
        </span>
      </div>
    </div>
  );
}
