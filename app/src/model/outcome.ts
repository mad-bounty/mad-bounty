// How a bounty actually ended, read off its timeline events (not off the state enum alone: "Paid"
// can mean the verifier accepted the work or that they stayed silent until the deadline, and those
// are very different stories). Everything here is pure.
import type { Address } from 'viem';
import type { TimelineEvent } from '../types';
import { duration, usdc } from './format';

export type Path = 'accept' | 'timeout' | 'burn' | 'refund' | 'cancelled' | 'none';

export interface Outcome {
  path: Path;
  /** headline for the hero, e.g. 'Paid · 1.95 USDC to 0x2Ae5…34f7' */
  headline: string;
  /** second line under the hero */
  detail: string;
  /** short word for pills / panel titles */
  word: string;
  /** the money that moved at the end, and where it went (address or a phrase), for the hero */
  amount?: bigint;
  to?: string;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const amt = (a: Record<string, unknown>, k: string): bigint | undefined =>
  typeof a[k] === 'bigint' ? (a[k] as bigint) : undefined;

/** The event that decided the bounty, if any. */
export function terminalEvent(events: TimelineEvent[]): TimelineEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i]!.kind;
    if (k === 'Paid' || k === 'Burned' || k === 'Refunded' || k === 'Cancelled' || k === 'Expired') return events[i];
  }
  return undefined;
}

/**
 * Which row of the money table the bounty actually realised, and the sentence to lead with.
 * `id` is used only to name the bounty in the cancelled case.
 */
export function outcomeOf(events: TimelineEvent[], id?: bigint): Outcome {
  const ev = terminalEvent(events);
  if (!ev) return { path: 'none', headline: '', detail: '', word: 'N/A' };
  const a = ev.args;
  switch (ev.kind) {
    case 'Paid': {
      const byTimeout = a.byTimeout === true;
      const paid = amt(a, 'toWorker');
      const fee = amt(a, 'fee');
      const worker = typeof a.worker === 'string' ? a.worker : undefined;
      const who = worker ? short(worker) : 'the worker';
      return {
        path: byTimeout ? 'timeout' : 'accept', amount: paid, to: worker,
        word: byTimeout ? 'Paid on timeout' : 'Accepted & paid',
        headline: paid !== undefined ? `Paid · ${usdc(paid)} to ${who}` : `Paid to ${who}`,
        detail: byTimeout
          ? `No verdict before the review deadline, so ${paid !== undefined ? `${usdc(paid)} went to ${who} automatically` : 'the worker was paid automatically'}${fee ? `; ${usdc(fee)} fee to the treasury` : ''}.`
          : `${paid !== undefined ? `${usdc(paid)} went to ${who}` : 'The worker was paid'} (reward minus fee, plus their deposit back)${fee ? `; ${usdc(fee)} fee to the treasury` : ''}.`,
      };
    }
    case 'Burned': {
      const burnt = amt(a, 'amount');
      return {
        path: 'burn', amount: burnt, to: 'burned (0x…dEaD)',
        word: 'Rejected & burned',
        headline: burnt !== undefined ? `Burned · ${usdc(burnt)} destroyed` : 'Burned',
        detail: 'The rejection became final after the 24h cooling-off period: the reward and the deposit were sent to the burn address.',
      };
    }
    case 'Refunded': {
      const back = amt(a, 'toAgent');
      const burntDep = amt(a, 'depositBurned');
      return {
        path: 'refund', amount: back, to: 'back to the poster',
        word: 'Rejected & refunded',
        headline: back !== undefined ? `Refunded · ${usdc(back)} to the poster` : 'Refunded to the poster',
        detail: burntDep ? `The rejection became final: the poster got the reward back and the worker's ${usdc(burntDep)} deposit burned.` : 'The rejection became final after the cooling-off period.',
      };
    }
    case 'Cancelled':
      return {
        path: 'cancelled', to: 'back to the poster',
        word: 'Cancelled',
        headline: 'Cancelled · reward returned to the poster',
        detail: `The poster cancelled${id !== undefined ? ` bounty #${id}` : ''} before anyone claimed it. Nothing was lost.`,
      };
    default:
      return {
        path: 'cancelled', to: 'back to the poster',
        word: 'Expired',
        headline: 'Expired · reward returned to the poster',
        detail: 'Nobody claimed it in the claim window, so the reward went back to the poster.',
      };
  }
}

const short = (a: string) => (a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);

/** 'You accepted this work' / 'You were paid' … for the panel when a wallet is connected. */
export function outcomeForViewer(o: Outcome, roles: { agent: string; worker?: string; verifier: string }, me?: Address): string | undefined {
  if (!me) return undefined;
  const iAm = { agent: same(me, roles.agent), worker: same(me, roles.worker), verifier: same(me, roles.verifier) };
  if (!iAm.agent && !iAm.worker && !iAm.verifier) return undefined;
  switch (o.path) {
    case 'accept':
      return iAm.verifier ? 'You accepted this work' : iAm.worker ? 'Your work was accepted' : 'The work you paid for was accepted';
    case 'timeout':
      return iAm.verifier ? 'You missed the review deadline, so the worker was paid' : iAm.worker ? 'You were paid on timeout' : 'The verifier missed the deadline, so the worker was paid';
    case 'burn':
      return iAm.verifier ? 'You rejected this work; the escrow burned' : iAm.worker ? 'Your work was rejected; your deposit burned' : 'The rejection stood: reward and deposit burned';
    case 'refund':
      return iAm.agent ? 'You got the reward back' : iAm.worker ? 'Your work was rejected; your deposit burned' : 'You rejected this work; the poster was refunded';
    case 'cancelled':
      return iAm.agent ? 'Your reward came back to you' : 'The poster got the reward back';
    default:
      return undefined;
  }
}

const NOUN: Record<string, string> = {
  Posted: 'posting', Claimed: 'claim', Submitted: 'submission', Rejected: 'reject', ReviewExtended: 'extension',
  Reversed: 'reversal', Abandoned: 'abandonment', Owed: 'queueing', Paid: 'payment', Cancelled: 'cancel', Expired: 'expiry',
  Burned: 'burn', Refunded: 'refund', Withdrawn: 'withdrawal',
};
/** Gap between two events, e.g. '22m after claim' / '7s after submission'. Empty for the same second. */
export function gapLabel(prev: number, next: number, prevKind: string): string {
  const d = next - prev;
  if (!isFinite(d) || d < 1 || !prev) return '';
  return `${duration(d)} after ${NOUN[prevKind] ?? prevKind.toLowerCase()}`;
}

/** Body line for a timeline row, built from event args. */
export function eventDetail(e: TimelineEvent, ctx: { reward: bigint; deposit: bigint; feeBps: bigint; verifier?: string }): string | undefined {
  const a = e.args;
  switch (e.kind) {
    case 'Claimed': {
      const d = typeof a.deadline === 'bigint' ? Number(a.deadline) : undefined;
      return `by ${typeof a.worker === 'string' ? short(a.worker) : 'a worker'}${ctx.deposit > 0n ? ` · deposit ${usdc(ctx.deposit)} escrowed` : ''}${d ? ` · submit by ${utcShort(d)}` : ''}`;
    }
    case 'Posted': {
      const r = amt(a, 'reward'); const dep = amt(a, 'deposit');
      return r !== undefined ? `${usdc(r)} reward${dep !== undefined ? ` + ${usdc(dep)} deposit` : ''} escrowed` : undefined;
    }
    case 'Submitted': {
      const h = typeof a.evidenceHash === 'string' ? a.evidenceHash : undefined;
      return h ? `evidence hash ${h.slice(0, 10)}… → verifier` : undefined;
    }
    case 'Rejected': {
      const c = typeof a.coolingEnd === 'bigint' ? Number(a.coolingEnd) : undefined;
      return c ? `cooling-off until ${utcShort(c)}` : undefined;
    }
    case 'Paid': {
      const paid = amt(a, 'toWorker'); const fee = amt(a, 'fee');
      const by = a.byTimeout === true ? 'paid on timeout — verifier silent' : `accepted by ${ctx.verifier ? short(ctx.verifier) : 'the verifier'}`;
      return [
        by,
        paid !== undefined ? `${usdc(paid)} to ${typeof a.worker === 'string' ? short(a.worker) : 'worker'}` : '',
        fee !== undefined && fee > 0n ? `${usdc(fee)} fee to treasury` : '',
      ].filter(Boolean).join(' · ');
    }
    case 'Burned': {
      const b = amt(a, 'amount');
      return b !== undefined ? `${usdc(b)} destroyed (reward${ctx.deposit > 0n ? ' + deposit' : ''})` : undefined;
    }
    case 'Refunded': {
      const back = amt(a, 'toAgent'); const dep = amt(a, 'depositBurned');
      return [
        back !== undefined ? `${usdc(back)} to the poster` : '',
        dep !== undefined && dep > 0n ? `${usdc(dep)} deposit burned` : '',
      ].filter(Boolean).join(' · ') || undefined;
    }
    case 'Cancelled':
      return `reward returned to the poster`;
    case 'Abandoned': {
      const dep = amt(a, 'depositBurned');
      return `work window missed${dep !== undefined ? ` · ${usdc(dep)} deposit burned` : ''}`;
    }
    case 'Reversed':
      return 'the verifier changed its mind and paid';
    default:
      return undefined;
  }
}

const utcShort = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// ----------------------------------------------------------------------------- spec → prefill
/**
 * Reverse the spec JSON written by buildSpecJson back into wizard fields. Only values the caller can
 * actually re-post are returned (the rest keeps the wizard default), and `notes` explains anything the
 * spec said that a new bounty cannot inherit — e.g. a verifier address that must be chosen again.
 */
export interface SpecPrefill {
  fields: { title: string; summary: string; instructions: string; criteria: string[]; evidenceFormat: string };
  notes: string[];
}

export function prefillFromSpec(spec: unknown): SpecPrefill | undefined {
  if (!spec || typeof spec !== 'object') return undefined;
  const sp = spec as Record<string, unknown>;
  if (typeof sp.title !== 'string' || typeof sp.instructions !== 'string') return undefined;
  const criteria: string[] = Array.isArray(sp.acceptanceCriteria)
    ? (sp.acceptanceCriteria as unknown[])
      .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).description : undefined))
      .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : [];
  let evidence = '';
  const ev = sp.evidenceFormat;
  if (typeof ev === 'string') evidence = ev;
  else if (ev && typeof ev === 'object') {
    const o = ev as Record<string, unknown>;
    if (typeof o.description === 'string') evidence = o.description;
    else if (Array.isArray(o.items)) {
      // inverse of postForm.parseEvidenceItems: one line per item, 'name | mediaType | description'
      evidence = (o.items as unknown[]).map((it) => {
        if (!it || typeof it !== 'object') return '';
        const r = it as Record<string, unknown>;
        const name = typeof r.name === 'string' ? r.name : '';
        const mt = typeof r.mediaType === 'string' && r.mediaType !== 'application/octet-stream' ? r.mediaType : '';
        const desc = typeof r.description === 'string' ? r.description : '';
        if (name === 'evidence' && !mt && !desc) return '';
        return [name, mt, desc].filter(Boolean).join(' | ');
      }).filter(Boolean).join('\n');
    }
  }
  const notes: string[] = [];
  const ver = sp.verifier;
  if (ver && typeof ver === 'object') {
    const k = (ver as Record<string, unknown>).kind;
    notes.push(typeof k === 'string'
      ? `The original verifier setup (${k}) is not copied — pick a reviewer again.`
      : 'Pick a reviewer again: the original verifier is not copied.');
  }
  return {
    fields: {
      title: sp.title.slice(0, 120),
      summary: typeof sp.summary === 'string' ? sp.summary : '',
      instructions: sp.instructions,
      criteria: criteria.length ? criteria : [''],
      evidenceFormat: evidence,
    },
    notes,
  };
}
