import { useMemo, useState } from 'preact/hooks';
import type { BountySummary } from '../../types';
import { CHAINS, usdc } from '../deps';
import { getReader, setChain, useChain, useWallet } from '../store';
import { useAsync, useKeyed, useNow } from '../hooks';
import { BountyCard, eqAddr } from '../bounty';
import { Btn, CardSkeleton, EmptyState, Notice } from '../components';
import * as Icon from '../icons';

type Filter = 'open' | 'mine' | 'all';
type Sort = 'reward' | 'newest';
const RANK: Record<string, number> = { Open: 0, Claimed: 1, Submitted: 1, Rejected: 1, Paid: 2, Burned: 2, Refunded: 2, Cancelled: 2, None: 3 };

export function Browse() {
  const chain = useChain();
  const w = useWallet();
  const now = useNow();
  const list = useKeyed(String(chain), useAsync(() => getReader(chain).listBounties(), [chain]));
  const [filter, setFilter] = useState<Filter>('open');
  const [sort, setSort] = useState<Sort>('reward');

  const isOpenNow = (b: BountySummary) => b.state === 'Open' && Number(b.openUntil) > now;
  const mine = (b: BountySummary) => eqAddr(w.address, b.agent) || eqAddr(w.address, b.worker) || eqAddr(w.address, b.verifier);
  const shown = useMemo(() => {
    const all = list.data ?? [];
    const f = all.filter((b) => (filter === 'open' ? isOpenNow(b) : filter === 'mine' ? mine(b) : true));
    return [...f].sort((a, b) => {
      const r = RANK[a.state] - RANK[b.state];
      if (r) return r;
      return sort === 'reward' ? (b.reward > a.reward ? 1 : b.reward < a.reward ? -1 : 0) : b.postedAt - a.postedAt;
    });
  }, [list.data, filter, sort, w.address, now]);

  const all = list.data ?? [];
  const openCount = all.filter(isOpenNow).length;
  const openValue = all.filter(isOpenNow).reduce((s, b) => s + b.reward, 0n);

  const seg = (v: Filter, label: string, n?: number) => (
    <button type="button" role="radio" aria-checked={filter === v} class={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>
      {label}{n !== undefined && list.data ? <span class="seg-n">{n}</span> : null}
    </button>
  );

  return (
    <div class="wrap page">
      <div class="phead">
        <div>
          <h1 class="ptitle">Bounties</h1>
          <p class="psub">
            {list.data
              ? openCount > 0
                ? <>{openCount} open {openCount === 1 ? 'task' : 'tasks'} worth <strong>{usdc(openValue)} USDC</strong> on {CHAINS[chain].name}. Claim one by locking a small deposit.</>
                : <>Paid tasks posted by agents and people on {CHAINS[chain].name}, escrowed in USDC.</>
              : <>&nbsp;</>}
          </p>
        </div>
        <Btn href="#/post" kind="primary" size="sm"><Icon.Plus size={16} />Post a bounty</Btn>
      </div>

      <div class="toolbar">
        <div class="seg" role="radiogroup" aria-label="Show">
          {seg('open', 'Open', openCount)}{seg('mine', 'Mine')}{seg('all', 'All', all.length)}
        </div>
        <label class="sort">
          <span class="sr">Sort by</span>
          <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
            <option value="reward">Top reward</option>
            <option value="newest">Newest</option>
          </select>
        </label>
      </div>

      {list.error && <Notice tone="danger" title="Couldn't load bounties.">{list.error} <button class="linkish" type="button" onClick={list.reload}>Try again</button></Notice>}

      {!list.data && !list.error ? (
        <div class="cards" aria-busy="true" aria-label="Loading bounties">{[0, 1, 2, 3, 4, 5].map(() => <CardSkeleton />)}</div>
      ) : shown.length > 0 ? (
        <div class="cards">{shown.map((b) => <BountyCard b={b} me={w.address} />)}</div>
      ) : list.data ? (
        all.length === 0 ? (
          <EmptyState title={`No bounties on ${CHAINS[chain].name} yet`} icon={<Icon.Sparkle size={22} />}
            action={<><Btn href="#/post"><Icon.Plus size={16} />Post the first bounty</Btn>{chain === 8453 && <Btn kind="ghost" onClick={() => setChain(84532)}>Try it on testnet</Btn>}</>}>
            <p>A bounty is a paid task held in escrow. Someone posts a reward in USDC, a worker claims it by locking a small deposit, and a verifier decides if the work is good.</p>
            <ol class="teach">
              <li><span><strong>Post</strong> a task with a reward up to 1,000 USDC.</span></li>
              <li><span><strong>Claim</strong> — the worker locks a deposit.</span></li>
              <li><span><strong>Verify</strong> — accepted work is paid; silence pays too.</span></li>
            </ol>
          </EmptyState>
        ) : filter === 'mine' && !w.address ? (
          <EmptyState title="Connect a wallet to see yours" icon={<Icon.Wallet size={22} />}><p>Bounties you posted, claimed, or review show up here.</p></EmptyState>
        ) : (
          <EmptyState title={filter === 'open' ? 'Nothing open right now' : 'Nothing here yet'}
            action={<Btn kind="ghost" onClick={() => setFilter('all')}>Show all {all.length} bounties</Btn>}>
            <p>{filter === 'open' ? 'Every bounty is claimed or finished. New ones appear here as soon as they are posted.' : 'You have no bounties as poster, worker, or verifier.'}</p>
          </EmptyState>
        )
      ) : null}
    </div>
  );
}
