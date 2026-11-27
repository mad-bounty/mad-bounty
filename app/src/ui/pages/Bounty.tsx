import type { BountyView } from '../../types';
import { nextStep } from '../deps';
import { getReader, useChain, useWallet } from '../store';
import { useAsync, useKeyed, useNow } from '../hooks';
import { BountyHeader, MoneyBox, Parties, SpecView, Timeline } from '../bounty';
import { ActionPanel } from '../actions';
import { Btn, EmptyState, Skeleton } from '../components';
import * as Icon from '../icons';

export function BountyPage({ id }: { id: bigint }) {
  const chain = useChain();
  const w = useWallet();
  const now = useNow();
  const q = useKeyed(`${chain}:${id}`, useAsync<BountyView>(() => getReader(chain).getBountyView(id), [chain, id.toString()]));

  if (q.error && !q.data) {
    return (
      <div class="wrap page">
        <EmptyState title={`Couldn't load bounty #${id}`} icon={<Icon.Alert size={22} />}
          action={<><Btn kind="ghost" onClick={q.reload}>Try again</Btn><Btn href="#/">All bounties</Btn></>}>
          <p>{q.error}</p>
          <p class="small muted">Bounty numbers are per network. Check the Base / Base Sepolia switch at the top.</p>
        </EmptyState>
      </div>
    );
  }
  if (!q.data) return <BountySkeleton />;
  const v = q.data;
  const next = nextStep(v, now);
  return (
    <div class="wrap page">
      <div class="bgrid">
        <div class="bmain">
          <BountyHeader v={v} />
          <div class="bside bside-mobile"><ActionPanel v={v} next={next} /></div>
          <SpecView s={v.spec} specHash={v.specHash} open={v.bounty.state === 'Open'} />
          <MoneyBox v={v} me={w.address} />
          <Parties v={v} me={w.address} />
          <Timeline v={v} next={next.deadline ? next : undefined} />
        </div>
        <aside class="bside" aria-label="Actions">
          <div class="bside-desk"><ActionPanel v={v} next={next} /></div>
        </aside>
      </div>
    </div>
  );
}

function BountySkeleton() {
  return (
    <div class="wrap page" aria-busy="true" aria-label="Loading bounty">
      <div class="bgrid">
        <div class="bmain">
          <div class="bhead"><Skeleton h={14} w={110} /><div style={{ height: '18px' }} /><Skeleton h={24} w={180} r={999} /><div style={{ height: '14px' }} /><Skeleton h={34} w="80%" /><div style={{ height: '18px' }} /><Skeleton h={56} w={220} /></div>
          <section class="panel"><Skeleton h={14} w="30%" /><div style={{ height: '14px' }} /><Skeleton h={14} /><div style={{ height: '8px' }} /><Skeleton h={14} w="85%" /><div style={{ height: '8px' }} /><Skeleton h={14} w="60%" /></section>
          <section class="panel"><Skeleton h={120} /></section>
        </div>
        <aside class="bside"><section class="panel"><Skeleton h={18} w="50%" /><div style={{ height: '12px' }} /><Skeleton h={14} /><div style={{ height: '18px' }} /><Skeleton h={50} r={999} /></section></aside>
      </div>
    </div>
  );
}
