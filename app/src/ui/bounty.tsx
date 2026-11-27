// Bounty building blocks: card, money box, timeline, spec view, parties.
import { acceptPayout } from '@madbounty/sdk';
import type { Address } from 'viem';
import type { BountySummary, BountyView, SpecStatus, TimelineEvent, TimelineKind } from '../types';
import { duration, shortAddr, usdc, utc, verifierKindLabel } from './deps';
import { Addr, CopyBtn, Countdown, KindChip, Money, Notice, Skeleton, StatePill, TxLink, When } from './components';
import { useNow } from './hooks';
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
  const role = eqAddr(me, b.agent) ? 'You posted' : eqAddr(me, b.worker) ? (done ? 'You worked on it' : 'You\'re working') : eqAddr(me, b.verifier) ? (done ? 'You reviewed' : 'You review') : undefined;
  return (
    <a class={`bcard${done ? ' is-done' : ''}`} href={`#/bounty/${b.id}`} aria-label={`${b.title}, reward ${usdc(b.reward)} USDC, ${b.state}`}>
      <div class="bc-top">
        <StatePill state={b.state} />
        <span class="bc-id mono">#{b.id.toString()}</span>
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
export function MoneyBox({ v, me }: { v: BountyView; me?: Address }) {
  const b = v.bounty;
  const { toWorker, fee } = acceptPayout(b.reward, b.deposit, b.feeBps);
  const youW = eqAddr(me, b.worker) || (b.state === 'Open' && !eqAddr(me, b.agent));
  const youA = eqAddr(me, b.agent);
  const refund = b.rejectMode === 'Refund';
  const pct = (Number(b.feeBps) / 100).toString();
  type Cell = { amt?: bigint; text: string; tone: 'pos' | 'neg' | 'neu' };
  const rows: { k: string; hint: string; worker: Cell; agent: Cell }[] = [
    { k: 'Work accepted', hint: `Worker gets reward minus ${pct}% fee, plus their deposit back.`,
      worker: { amt: toWorker, text: 'paid out', tone: 'pos' }, agent: { text: 'Reward goes to worker', tone: 'neu' } },
    { k: 'Work rejected', hint: refund ? 'After a 24h cooling-off period, the reward returns to the poster and the deposit burns.' : 'After a 24h cooling-off period, the reward and the deposit both burn.',
      worker: { amt: b.deposit, text: 'loses deposit', tone: 'neg' },
      agent: refund ? { amt: b.reward, text: 'gets back', tone: 'pos' } : { amt: b.reward, text: 'reward burns', tone: 'neg' } },
    { k: 'Verifier silent', hint: 'If nobody gives a verdict before the review deadline, the worker is paid.',
      worker: { amt: toWorker, text: 'paid out', tone: 'pos' }, agent: { text: 'Reward goes to worker', tone: 'neu' } },
    { k: 'Worker abandons', hint: 'If no work arrives in time, the deposit burns and the bounty reopens.',
      worker: { amt: b.deposit, text: 'loses deposit', tone: 'neg' }, agent: { text: 'Bounty reopens', tone: 'neu' } },
  ];
  const cell = (c: Cell, who: string) => (
    <td class={`mb-${c.tone}`} data-label={who}>
      {c.amt !== undefined ? <><span class="mb-amt">{c.tone === 'neg' ? '−' : c.tone === 'pos' ? '+' : ''}{usdc(c.amt)}</span><span class="mb-u"> USDC</span><span class="mb-t">{c.text}</span></> : <span class="mb-t mb-t-only">{c.text}</span>}
    </td>
  );
  return (
    <section class="panel" aria-labelledby="mb-h">
      <h2 class="panel-h" id="mb-h"><Icon.Coins size={18} />Who gets what</h2>
      <div class="mb-in">
        <div><span class="k">Reward</span><Money v={b.reward} /></div>
        <div><span class="k">Deposit</span><Money v={b.deposit} /></div>
        <div><span class="k">Fee</span><span class="money money-md">{pct}%<span class="money-unit"> · {usdc(fee)} USDC</span></span></div>
      </div>
      <table class="mbox">
        <thead><tr><th scope="col">If…</th><th scope="col">Worker{youW ? ' (you)' : ''}</th><th scope="col">Poster{youA ? ' (you)' : ''}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr><th scope="row" title={r.hint}>{r.k}<span class="mb-hint">{r.hint}</span></th>{cell(r.worker, youW ? 'Worker (you)' : 'Worker')}{cell(r.agent, youA ? 'Poster (you)' : 'Poster')}</tr>
          ))}
        </tbody>
      </table>
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
      <div class="party"><span class="k">Windows</span><span class="v">{duration(b.workWindow)} to work · {duration(b.reviewWindow)} to review</span></div>
      {!isZero(b.claimAuthorizer) && row('Claim approval', b.claimAuthorizer)}
      <div class="party"><span class="k">Vault</span><span class="v"><Addr a={b.vault} label="vault" /> <span class="muted small">holds {usdc(v.vaultBalance)} USDC</span></span></div>
    </section>
  );
}

// ---------------------------------------------------------------- Timeline
const TL: Record<TimelineKind, { label: string; tone: string }> = {
  Posted: { label: 'Posted', tone: 'accent' }, Cancelled: { label: 'Cancelled by poster', tone: 'muted' }, Expired: { label: 'Expired', tone: 'muted' },
  Claimed: { label: 'Claimed', tone: 'gold' }, Submitted: { label: 'Work submitted', tone: 'gold' }, ReviewExtended: { label: 'Review extended', tone: 'gold' },
  Rejected: { label: 'Rejected', tone: 'danger' }, Reversed: { label: 'Rejection reversed', tone: 'green' }, Paid: { label: 'Worker paid', tone: 'green' },
  Burned: { label: 'Funds burned', tone: 'danger' }, Refunded: { label: 'Refunded to poster', tone: 'muted' }, Abandoned: { label: 'Abandoned · reopened', tone: 'danger' },
  Owed: { label: 'Payment queued', tone: 'gold' }, Withdrawn: { label: 'Withdrawn', tone: 'green' },
};
function tlDetail(e: TimelineEvent): string | undefined {
  const a = e.args;
  const amt = (k: string) => (typeof a[k] === 'bigint' ? `${usdc(a[k] as bigint)} USDC` : undefined);
  if (e.kind === 'Claimed' && typeof a.worker === 'string') return `by ${shortAddr(a.worker)}`;
  if (e.kind === 'Posted') return amt('reward') && `${amt('reward')} escrowed`;
  if (e.kind === 'Paid') return amt('toWorker') && `${amt('toWorker')} to worker`;
  if (e.kind === 'Owed' || e.kind === 'Withdrawn') return amt('amount');
  return undefined;
}
export function Timeline({ events, next }: { events: TimelineEvent[]; next?: { headline: string; deadline?: number } }) {
  return (
    <section class="panel" aria-labelledby="tl-h">
      <h2 class="panel-h" id="tl-h"><Icon.Clock size={18} />Timeline</h2>
      <ol class="tl">
        {events.map((e) => {
          const m = TL[e.kind]; const d = tlDetail(e);
          return (
            <li class={`tl-i tone-${m.tone}`}>
              <span class="tl-dot" aria-hidden="true" />
              <div class="tl-b">
                <span class="tl-l">{m.label}</span>
                {d && <span class="tl-d">{d}</span>}
                <span class="tl-m"><When t={e.time} /> · <TxLink hash={e.tx}>tx</TxLink></span>
              </div>
            </li>
          );
        })}
        {next && (
          <li class="tl-i tl-next">
            <span class="tl-dot" aria-hidden="true" />
            <div class="tl-b"><span class="tl-l">Next: {next.headline}</span>{next.deadline ? <span class="tl-m" title={utc(next.deadline)}>deadline <When t={next.deadline} /></span> : null}</div>
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
export function SpecView({ s, specHash, open = true }: { s: SpecStatus; specHash: string; open?: boolean }) {
  if (s.kind === 'loading') {
    return <section class="panel"><Skeleton h={14} w="40%" /><div style={{ height: '12px' }} /><Skeleton h={14} /><Skeleton h={14} w="90%" /><Skeleton h={14} w="70%" /></section>;
  }
  if (s.kind !== 'verified') {
    return (
      <section class="panel" aria-labelledby="sp-h">
        <h2 class="panel-h" id="sp-h"><Icon.Doc size={18} />The task</h2>
        {s.kind === 'mismatch' && <Notice tone="danger" title="Spec doesn't match.">The text found in the post transaction does not hash to the on-chain specHash. Don't rely on it — ask the poster for the real spec.</Notice>}
        {s.kind === 'offchain' && <Notice tone="info" title="Spec not published on-chain.">The poster (probably an agent using the SDK) hosts the task text elsewhere.{open ? ' Get it from them and check that its keccak256 equals the hash below before claiming.' : ' Its keccak256 must equal the hash below.'}</Notice>}
        {s.kind === 'invalid' && <Notice tone="warn" title="Spec can't be read.">{s.reason}</Notice>}
        <div class="hashline"><span class="k">specHash</span><span class="hash-row"><code class="mono">{specHash}</code><CopyBtn text={specHash} label="specHash" /></span></div>
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
  const now = useNow();
  return (
    <div class="bhead">
      <div class="bhead-top">
        <a class="back" href="#/"><Icon.Back size={16} />All bounties</a>
      </div>
      <div class="bhead-pills"><StatePill state={b.state} /><KindChip kind={v.verifierKind} /><span class="bc-id mono">#{b.id.toString()}</span></div>
      <h1 class="bhead-t">{v.title}</h1>
      <div class="bhead-reward">
        <Money v={b.reward} size="hero" />
        <span class="bhead-sub">reward{b.state === 'Open' ? <> · claim with a <strong>{usdc(b.deposit)} USDC</strong> deposit</> : null}</span>
      </div>
      <div class="bhead-meta">
        {clock && !['Paid', 'Burned', 'Refunded', 'Cancelled'].includes(b.state) && <Countdown to={clock.to} label={clock.label} />}
        <span class="muted small">Posted <When t={v.postedAt} /></span>
        {now > 0 && null}
      </div>
    </div>
  );
}
