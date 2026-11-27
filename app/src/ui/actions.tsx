// Action panel, confirmation sheet, worker safety check, evidence form.
import { useMemo, useState } from 'preact/hooks';
import { assessBounty, type SafetyWarning } from '@madbounty/sdk';
import type { Address, Hex } from 'viem';
import type { ActionId, ActionOption, BountyView, NextStep } from '../types';
import { CHAINS, availableActions, relTime, usdc, utc } from './deps';
import { getWriter, openWalletPicker, runTx, useChain, useWallet } from './store';
import { useNow } from './hooks';
import { Btn, Modal, Notice } from './components';
import * as Icon from './icons';

const ROLE: Record<ActionOption['role'], string> = { agent: 'Poster', worker: 'Worker', verifier: 'Verifier', anyone: 'Anyone' };

/** What the sheet says before the wallet opens, by action. Plain words, no protocol jargon. */
const EXPLAIN: Partial<Record<ActionId, string>> = {
  claim: 'You lock your deposit and the task is reserved for you. Submit your work before the deadline, or the deposit burns and the bounty reopens.',
  submit: 'Your evidence is hashed in your browser and only the hash goes on-chain. The verifier then has the review window to accept or reject. If they say nothing, you get paid.',
  accept: 'The worker is paid immediately. This is final.',
  reject: 'Starts a 24-hour cooling period. You can reverse it during that time. After it, the funds go as shown below — burning can\'t be undone.',
  reverse: 'Undo your rejection and pay the worker now. This is final.',
  extendReview: 'Adds one more review window. This can be done once per bounty.',
  cancel: 'Nobody has claimed it yet, so your full reward comes back to you and the bounty closes.',
  payOnTimeout: 'The verifier missed the review deadline, so the rules say the worker gets paid. Anyone can trigger this; you only pay gas.',
  finalizeReject: 'The 24-hour cooling period is over. This executes the rejection. You only pay gas.',
  reclaimAbandoned: 'The worker missed the work deadline. Their deposit burns and the bounty reopens for others. You only pay gas.',
  refundExpired: 'Nobody claimed in time. The reward goes back to the poster. You only pay gas.',
  withdraw: 'Moves USDC the contract owes you into your wallet.',
  hashReveal: 'Publishes the answer so the hash-reveal verifier can decide. Anyone can then see the answer.',
};

/** Sheet button text: unambiguous next to "Not now". */
const CONFIRM: Partial<Record<ActionId, string>> = {
  cancel: 'Yes, cancel & refund me', claim: 'Claim & lock deposit', accept: 'Accept & pay worker', reject: 'Reject work',
  submit: 'Submit work', payOnTimeout: 'Pay the worker', refundExpired: 'Refund the poster', reclaimAbandoned: 'Reopen bounty',
  finalizeReject: 'Finalize rejection',
};

export function safetyFor(v: BountyView, me: Address | undefined, now: number): SafetyWarning[] {
  const a = CHAINS[v.chainId].adapters;
  try {
    const r = assessBounty(v.bounty, {
      now: BigInt(now), worker: me, verifierIsContract: !['self', 'eoa'].includes(v.verifierKind),
      knownSafeVerifiers: Object.values(a) as Address[],
    });
    return r.warnings.filter((w) => w.code !== 'NOT_OPEN' && w.code !== 'REJECT_OUTCOME');
  } catch { return []; }
}
const plain = (w: SafetyWarning) => w.message.replace(/\bagent\b/g, 'poster').replace(/openUntil/g, 'the claim deadline').replace(/\s*Pass `adapters` \+ `trustedSigners`\.?/, ' Check who controls the verdict before claiming.').replace(/`/g, '');

export function ActionPanel({ v, next }: { v: BountyView; next: NextStep }) {
  const w = useWallet();
  const chain = useChain();
  const now = useNow();
  const me = w.address;
  const actions = useMemo(() => availableActions(v, me, now), [v, me, now]);
  const [open, setOpen] = useState<ActionOption>();
  const [busy, setBusy] = useState<ActionId>();

  // role-specific actions for the connected user first; permissionless cleanups in their own group
  const primary = actions.find((a) => a.primary && a.enabled) ?? actions.find((a) => a.primary);
  const mine = actions.filter((a) => a !== primary && a.role !== 'anyone' && a.enabled);
  const anyone = actions.filter((a) => a !== primary && a.role === 'anyone');
  const blocked = actions.filter((a) => a !== primary && a.role !== 'anyone' && !a.enabled);

  const start = (a: ActionOption) => { if (!me) { openWalletPicker(); return; } setOpen(a); };

  return (
    <section class="panel apanel" aria-labelledby="ap-h">
      <h2 class="sr" id="ap-h">What you can do</h2>
      <div class="next">
        <span class="next-k">What happens next</span>
        <strong class="next-h">{next.headline}</strong>
        <p class="next-d">{next.detail}</p>
        {next.deadline && <span class="next-dl" title={utc(next.deadline)}><Icon.Clock size={14} />{next.deadline > now ? 'Deadline' : 'Deadline passed'}: <time>{utc(next.deadline)}</time></span>}
      </div>

      {primary && (
        <div class="ap-primary">
          <Btn kind={primary.danger === 'destructive' ? 'danger' : 'primary'} size="lg" full disabled={!primary.enabled || (!!busy && busy !== primary.id)} busy={busy === primary.id}
            onClick={() => start(primary)}>
            {!me ? <><Icon.Wallet size={18} />Connect wallet to {primary.label.toLowerCase()}</> : primary.label}
          </Btn>
          <p class={`why${primary.enabled ? '' : ' why-off'}`}>{primary.why}</p>
        </div>
      )}
      {!primary && !me && actions.some((a) => a.role !== 'anyone') && (
        <div class="ap-primary">
          <Btn kind="primary" size="lg" full onClick={openWalletPicker}><Icon.Wallet size={18} />Connect wallet</Btn>
          <p class="why">Connect to see the actions for your role.</p>
        </div>
      )}

      {mine.length > 0 && (
        <div class="ap-group">
          {mine.map((a) => <ActionRow a={a} onGo={start} busy={busy === a.id} locked={!!busy} />)}
        </div>
      )}
      {anyone.length > 0 && (
        <div class="ap-group">
          <h3 class="ap-gh">Anyone can do this</h3>
          {anyone.map((a) => <ActionRow a={a} onGo={start} busy={busy === a.id} locked={!!busy} />)}
        </div>
      )}
      {blocked.length > 0 && me && (
        <details class="ap-more">
          <summary>Other actions ({blocked.length})</summary>
          {blocked.map((a) => <ActionRow a={a} onGo={start} busy={false} />)}
        </details>
      )}
      {actions.length === 0 && <p class="muted small">This bounty is finished. Nothing left to do.</p>}

      {open && (
        <ConfirmSheet v={v} a={open} me={me!} now={now} onClose={() => setOpen(undefined)}
          onConfirm={async (extra) => {
            const a = open; setOpen(undefined); setBusy(a.id);
            await runTx(chain, a.label, async (onP) => {
              const wr = await getWriter(v.chainId);
              const id = v.bounty.id;
              switch (a.id) {
                case 'claim': return wr.claim(id, onP);
                case 'submit': return wr.submit(id, extra ?? '', onP);
                case 'accept': return wr.settle(id, true, onP);
                case 'reject': return wr.settle(id, false, onP);
                case 'reverse': return wr.reverse(id, onP);
                case 'extendReview': return wr.extendReview(id, onP);
                case 'cancel': return wr.cancel(id, onP);
                case 'payOnTimeout': return wr.payOnTimeout(id, onP);
                case 'finalizeReject': return wr.finalizeReject(id, onP);
                case 'reclaimAbandoned': return wr.reclaimAbandoned(id, onP);
                case 'refundExpired': return wr.refundExpired(id, onP);
                case 'withdraw': return wr.withdraw(id, onP);
                case 'hashReveal': return wr.hashRevealReveal(id, (extra ?? '0x') as Hex, onP);
                case 'adapterResolve':
                  if (v.verifierKind === 'onchainCheck') return wr.onchainCheckResolve(id, onP);
                  throw new Error('This verdict has to be relayed with the verifier\'s signature (SDK or MCP server), not from this page.');
                default: throw new Error('This action is not available in the app yet. Use the SDK or MCP server.');
              }
            }, v.bounty.id);
            setBusy(undefined);
          }} />
      )}
    </section>
  );
}

function ActionRow({ a, onGo, busy, locked }: { a: ActionOption; onGo: (a: ActionOption) => void; busy: boolean; locked?: boolean }) {
  const now = useNow();
  return (
    <div class={`arow${a.enabled ? '' : ' arow-off'}`}>
      <div class="arow-t">
        <span class="arow-l">{a.label}</span>
        <span class="arow-w">{a.why}</span>
      </div>
      <Btn kind={a.danger === 'destructive' ? 'danger' : 'ghost'} size="sm" disabled={!a.enabled || locked} busy={busy} onClick={() => onGo(a)} label={a.enabled ? a.label : `${a.label} (${a.why})`}>
        {a.enabled ? (a.role === 'anyone' ? 'Do it' : 'Go') : <><Icon.Clock size={14} />{a.availableAt ? relTime(a.availableAt, now).replace(/^in /, '') : 'Later'}</>}
      </Btn>
    </div>
  );
}

const TO_TONE = (to: string) => /burn/i.test(to) ? 'neg' : /treasury|fee|escrow|vault/i.test(to) ? 'neu' : 'pos';
const TO_LABEL: Record<string, string> = { worker: 'Worker', agent: 'Poster', you: 'You', burn: 'Burned', treasury: 'Protocol fee', escrow: 'Escrow vault' };
const toLabel = (to: string) => TO_LABEL[to.toLowerCase()] ?? to;

export function ConfirmSheet({ v, a, me, now, onClose, onConfirm }: {
  v: BountyView; a: ActionOption; me: Address; now: number; onClose: () => void; onConfirm: (extra?: string) => void;
}) {
  const [evidence, setEvidence] = useState('');
  const [answer, setAnswer] = useState('');
  const b = v.bounty;
  const warnings = a.id === 'claim' ? safetyFor(v, me, now) : [];
  const danger = warnings.filter((w) => w.severity === 'DANGER');
  const needsEvidence = a.id === 'submit';
  const needsAnswer = a.id === 'hashReveal';
  const hexOk = /^0x[0-9a-fA-F]*$/.test(answer) && answer.length > 2;
  const canGo = needsEvidence ? evidence.trim().length > 0 : needsAnswer ? hexOk : true;
  const title = a.id === 'cancel' ? `Cancel bounty #${b.id}?` : a.id === 'accept' ? 'Accept the work and pay?' : a.id === 'reject' ? 'Reject this work?' : a.id === 'claim' ? `Claim bounty #${b.id}?` : `${a.label}?`;

  return (
    <Modal open onClose={onClose} title={title} labelledBy="cs-title">
      <div class="sheet-body">
        <p class="cs-what">{EXPLAIN[a.id] ?? a.why}</p>

        {needsEvidence && (
          <div class="field">
            <label for="ev">Your evidence</label>
            <textarea id="ev" rows={5} value={evidence} onInput={(e) => setEvidence((e.target as HTMLTextAreaElement).value)}
              placeholder="Link to your work, plus anything the verifier needs to check it" data-autofocus />
            <p class="hint"><Icon.Info size={14} />We store only the hash of this text on-chain. Share the evidence itself with the verifier (paste the same text), or they can't check it.</p>
          </div>
        )}
        {needsAnswer && (
          <div class="field">
            <label for="ans">Answer (hex)</label>
            <input id="ans" class="mono" value={answer} onInput={(e) => setAnswer((e.target as HTMLInputElement).value.trim())} placeholder="0x…" data-autofocus />
            {!hexOk && answer && <p class="err">Enter 0x followed by hex characters.</p>}
          </div>
        )}

        {a.money && a.money.length > 0 && (
          <table class="moves" aria-label="Money moves">
            <tbody>
              {a.money.map((m) => (
                <tr class={`mv-${TO_TONE(m.to)}`}>
                  <th scope="row">{m.label}</th>
                  <td class="mv-to"><Icon.Arrow size={13} />{toLabel(m.to)}</td>
                  <td class="mv-amt">{usdc(m.amount)}<span> USDC</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <dl class="cs-facts">
          <div><dt>Bounty</dt><dd>#{b.id.toString()} · {usdc(b.reward)} USDC reward</dd></div>
          {['claim', 'submit', 'accept', 'reject'].includes(a.id) && <div><dt>On reject</dt><dd>{b.rejectMode === 'Refund' ? 'Reward back to poster, deposit burns' : 'Reward + deposit burn'}</dd></div>}
          <div><dt>Network</dt><dd>{CHAINS[v.chainId].name}</dd></div>
        </dl>

        {warnings.length > 0 && (
          <div class={`safety${danger.length ? ' safety-danger' : ''}`}>
            <h3 class="safety-h">{danger.length ? <><Icon.Alert size={16} />Safety check: {danger.length} serious {danger.length === 1 ? 'risk' : 'risks'}</> : <><Icon.Shield size={16} />Safety check</>}</h3>
            <ul>
              {warnings.map((w) => <li class={`sw sw-${w.severity.toLowerCase()}`}><span class="sw-s">{w.severity === 'DANGER' ? 'Risk' : w.severity === 'WARN' ? 'Caution' : 'Note'}</span>{plain(w)}</li>)}
            </ul>
          </div>
        )}

        <p class="audit-line"><Icon.Alert size={14} /><span>MAD Bounty is <strong>NOT externally audited</strong>. Contracts are immutable; only risk what you can afford to lose.</span></p>
      </div>
      <div class="sheet-foot">
        <span class="sheet-note">Opens your wallet</span>
        <Btn kind="quiet" onClick={onClose}>Not now</Btn>
        <Btn kind={a.danger === 'destructive' ? 'danger' : 'primary'} disabled={!canGo} onClick={() => onConfirm(needsEvidence ? evidence : needsAnswer ? answer : undefined)}>
          {CONFIRM[a.id] ?? a.label}
        </Btn>
      </div>
    </Modal>
  );
}
