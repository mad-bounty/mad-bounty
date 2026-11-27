import type { Address } from 'viem';
import type { ActionOption, BountySummary, BountyView } from '../../types';
import { CHAINS, availableActions } from '../deps';
import { getReader, openWalletPicker, useChain, useWallet } from '../store';
import { useAsync, useKeyed, useNow } from '../hooks';
import { BountyCard, eqAddr } from '../bounty';
import { Btn, CardSkeleton, EmptyState, Notice, StatePill, Money } from '../components';
import * as Icon from '../icons';

const TERMINAL = ['Paid', 'Burned', 'Refunded', 'Cancelled'];

/** A to-do is something the user is expected to do (or that pays them), not an optional action like Cancel. */
function isTodo(a: ActionOption, v: BountyView, me: Address): boolean {
  const b = v.bounty;
  if (['submit', 'accept', 'withdraw', 'hashReveal', 'adapterResolve'].includes(a.id)) return a.role !== 'anyone' || a.id === 'withdraw';
  if (a.id === 'payOnTimeout') return eqAddr(me, b.worker);
  if (a.id === 'refundExpired' || a.id === 'reclaimAbandoned') return eqAddr(me, b.agent);
  return false;
}

export function MePage() {
  const chain = useChain();
  const w = useWallet();
  const now = useNow();
  const me = w.address;
  const list = useKeyed(`${chain}:${me}`, useAsync(async () => {
    if (!me) return undefined;
    const r = getReader(chain);
    const all = await r.listBounties();
    const mine = all.filter((b) => eqAddr(me, b.agent) || eqAddr(me, b.worker) || eqAddr(me, b.verifier));
    // Load full views only for live bounties to compute what needs this user's action.
    const live = mine.filter((b) => !TERMINAL.includes(b.state));
    const views = await Promise.all(live.map((b) => r.getBountyView(b.id).catch(() => undefined)));
    return { mine, views: views.filter(Boolean) as BountyView[] };
  }, [chain, me]));

  if (!me) {
    return (
      <div class="wrap page">
        <div class="phead"><div><h1 class="ptitle">My bounties</h1><p class="psub">Everything you posted, claimed, or review.</p></div></div>
        <EmptyState title="Connect a wallet to see your bounties" icon={<Icon.Wallet size={22} />} action={<Btn onClick={openWalletPicker}><Icon.Wallet size={16} />Connect wallet</Btn>}>
          <p>Nothing is stored by this site. Your bounties are found by reading the contract for your address.</p>
        </EmptyState>
      </div>
    );
  }

  const data = list.data;
  const todo: { v: BountyView; a: ActionOption }[] = [];
  for (const v of data?.views ?? []) {
    const a = availableActions(v, me, now).find((x) => x.enabled && isTodo(x, v, me));
    if (a) todo.push({ v, a });
  }
  const group = (role: 'agent' | 'worker' | 'verifier') => (data?.mine ?? []).filter((b) => eqAddr(me, b[role])).sort((a, b) => (TERMINAL.includes(a.state) ? 1 : 0) - (TERMINAL.includes(b.state) ? 1 : 0) || b.postedAt - a.postedAt);

  return (
    <div class="wrap page">
      <div class="phead"><div><h1 class="ptitle">My bounties</h1><p class="psub">On {CHAINS[chain].name} for <span class="mono">{me.slice(0, 6)}…{me.slice(-4)}</span>.</p></div><Btn href="#/post" size="sm"><Icon.Plus size={16} />Post a bounty</Btn></div>
      {list.error && <Notice tone="danger" title="Couldn't load.">{list.error}</Notice>}
      {!data && !list.error ? (
        <div class="cards" aria-busy="true">{[0, 1, 2].map(() => <CardSkeleton />)}</div>
      ) : data && data.mine.length === 0 ? (
        <EmptyState title="Nothing yet" action={<><Btn href="#/">Find a bounty</Btn><Btn kind="ghost" href="#/post">Post one</Btn></>}>
          <p>Bounties you post, claim, or are named verifier on will appear here.</p>
        </EmptyState>
      ) : data ? (
        <>
          <section class="todo" aria-labelledby="todo-h">
            <h2 class="sec-h" id="todo-h">Needs your action {todo.length > 0 && <span class="count">{todo.length}</span>}</h2>
            {todo.length === 0 ? <p class="muted">You're all caught up. Nothing is waiting on you.</p> : (
              <ul class="todo-l">
                {todo.map(({ v, a }) => (
                  <li>
                    <a class="todo-i" href={`#/bounty/${v.bounty.id}`}>
                      <StatePill state={v.bounty.state} />
                      <span class="todo-t"><strong>{v.title}</strong><span class="muted small">{a.why}</span></span>
                      <span class="todo-r"><Money v={v.bounty.reward} size="sm" /><span class="todo-cta">{a.label}<Icon.Arrow size={14} /></span></span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <RoleGroup title="Posted by you" list={group('agent')} me={me} />
          <RoleGroup title="You're working on" list={group('worker')} me={me} />
          <RoleGroup title="You're the verifier" list={group('verifier')} me={me} />
        </>
      ) : null}
    </div>
  );
}

function RoleGroup({ title, list, me }: { title: string; list: BountySummary[]; me: Address }) {
  if (!list.length) return null;
  return (
    <section class="rgroup">
      <h2 class="sec-h">{title} <span class="count count-q">{list.length}</span></h2>
      <div class="cards">{list.map((b) => <BountyCard b={b} me={me} />)}</div>
    </section>
  );
}
