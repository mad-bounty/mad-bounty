import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal window shim for EIP-6963 discovery in node.
const target = new EventTarget();
(globalThis as any).window = Object.assign(target, { ethereum: undefined as unknown });
const mem = new Map<string, string>();
(globalThis as any).sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

const { discoverWallets, walletStore, connect, ensureChain, disconnect, createStore, _resetWalletForTests } = await import('../src/chain/wallet');

function fakeProvider(chainId = 1, knownChains = new Set([1, 8453])) {
  const listeners: Record<string, ((...a: any[]) => void)[]> = {};
  let chain = chainId;
  const calls: string[] = [];
  return {
    calls,
    emit: (ev: string, ...a: any[]) => (listeners[ev] ?? []).forEach((f) => f(...a)),
    on: (ev: string, f: any) => { (listeners[ev] ??= []).push(f); },
    removeListener: (ev: string, f: any) => { listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== f); },
    async request({ method, params }: { method: string; params?: any }) {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0xdb04000000000000000000000000000000d720'.padEnd(42, '0')];
      if (method === 'eth_chainId') return '0x' + chain.toString(16);
      if (method === 'wallet_switchEthereumChain') {
        const want = Number(params[0].chainId);
        if (!knownChains.has(want)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
        chain = want; return null;
      }
      if (method === 'wallet_addEthereumChain') { const id = Number(params[0].chainId); knownChains.add(id); chain = id; return null; }
      throw new Error('unsupported ' + method);
    },
  };
}

test('store subscribe/get/set', () => {
  const s = createStore({ n: 0 });
  const seen: number[] = [];
  const off = s.subscribe((v) => seen.push(v.n));
  s.set({ n: 1 }); off(); s.set({ n: 2 });
  assert.deepEqual(seen, [1]);
  assert.equal(s.get().n, 2);
});

test('EIP-6963 discovery + connect + events + ensureChain (switch, then add on 4902)', async () => {
  _resetWalletForTests();
  const p = fakeProvider(1);
  target.addEventListener('eip6963:requestProvider', () => {
    target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), {
      detail: { info: { uuid: 'u1', name: 'Fake', icon: '', rdns: 'io.fake' }, provider: p },
    }));
  });
  discoverWallets(10);
  assert.equal(walletStore.get().providers.length, 1);
  const info = walletStore.get().providers[0]!;
  const c = await connect(info);
  assert.equal(c.chainId, 1);
  assert.equal(walletStore.get().supported, false);

  await ensureChain(8453);                // known → switch
  assert.equal(walletStore.get().chainId, 8453);
  assert.equal(walletStore.get().supported, true);

  await ensureChain(84532);               // unknown → 4902 → add
  assert.ok(p.calls.includes('wallet_addEthereumChain'));
  assert.equal(walletStore.get().chainId, 84532);

  p.emit('chainChanged', '0x2105');
  assert.equal(walletStore.get().chainId, 8453);
  p.emit('accountsChanged', []);
  assert.equal(walletStore.get().address, undefined);
  disconnect();
});

test('falls back to window.ethereum when nothing announces', async () => {
  _resetWalletForTests();
  const t2 = new EventTarget();
  const p = fakeProvider(8453);
  (globalThis as any).window = Object.assign(t2, { ethereum: Object.assign(p, { isMetaMask: true }) });
  discoverWallets(5);
  await new Promise((r) => setTimeout(r, 20));
  const list = walletStore.get().providers;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'MetaMask');
});
