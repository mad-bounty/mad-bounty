// App-level state: selected chain, wallet mirror, readers, toasts, modals. Tiny observable stores, no libs.
import { useEffect, useState } from 'preact/hooks';
import type { Address, Hex } from 'viem';
import type { ChainId, TxProgress } from '../types';
import { createReader, createWriter, ensureChain, friendlyError, wallet, type Reader, type WalletState } from './deps';

export interface Store<T> { get(): T; set(v: T): void; subscribe(fn: (v: T) => void): () => void }
export function createStore<T>(init: T): Store<T> {
  let v = init;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => v,
    set(n) { v = n; subs.forEach((f) => f(v)); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
export function useStore<T>(s: Store<T>): T {
  const [v, setV] = useState(s.get());
  useEffect(() => { setV(s.get()); return s.subscribe(setV); }, [s]);
  return v;
}

// ---------- chain selection (persisted locally; no cookies)
const KEY = 'madb.chain';
function initialChain(): ChainId {
  try { return localStorage.getItem(KEY) === '84532' ? 84532 : 8453; } catch { return 8453; }
}
export const chainStore = createStore<ChainId>(initialChain());
export function setChain(c: ChainId) {
  if (chainStore.get() === c) return;
  try { localStorage.setItem(KEY, String(c)); } catch { /* private mode */ }
  chainStore.set(c);
}
export const useChain = () => useStore(chainStore);

// ---------- wallet mirror
export function useWallet(): WalletState {
  const [s, setS] = useState<WalletState>(wallet.get());
  useEffect(() => { setS(wallet.get()); return wallet.subscribe((n: WalletState) => setS(n)); }, []);
  return s;
}

// ---------- readers (one per chain, cached)
const readers = new Map<ChainId, Reader>();
export function getReader(c: ChainId): Reader {
  let r = readers.get(c);
  if (!r) { r = createReader(c); readers.set(c, r); }
  return r;
}
/** bump to make pages refetch after a confirmed tx */
export const refreshStore = createStore(0);
export const bumpRefresh = () => refreshStore.set(refreshStore.get() + 1);

// ---------- modals
export const walletPickerOpen = createStore(false);
export const openWalletPicker = () => walletPickerOpen.set(true);

// ---------- toasts
export interface Toast extends TxProgress { id: number; chainId: ChainId; title: string }
export const toastStore = createStore<Toast[]>([]);
let tid = 0;
export function dismissToast(id: number) { toastStore.set(toastStore.get().filter((t) => t.id !== id)); }
function upsertToast(t: Toast) {
  const list = toastStore.get();
  const i = list.findIndex((x) => x.id === t.id);
  toastStore.set(i < 0 ? [...list, t].slice(-4) : list.map((x) => (x.id === t.id ? t : x)));
  if (t.stage === 'confirmed') setTimeout(() => dismissToast(t.id), 8000);
}

export class NeedWallet extends Error {}

/** Get a writer for the selected chain, prompting for a wallet / chain switch if needed. */
export async function getWriter(chainId: ChainId) {
  const w = wallet.get();
  if (!w.address) { openWalletPicker(); throw new NeedWallet('Connect a wallet first.'); }
  if (w.chainId !== chainId) await ensureChain(chainId);
  const now = wallet.get();
  if (!now.walletClient || !now.address) { openWalletPicker(); throw new NeedWallet('Connect a wallet first.'); }
  return createWriter({ chainId, walletClient: now.walletClient, account: now.address as Address, reader: getReader(chainId) });
}

/**
 * Run one wallet action with a toast that follows it: wallet → submitted → confirmed / failed.
 * Returns the result, or undefined if it failed (the toast already explains why).
 */
export async function runTx<T>(chainId: ChainId, title: string, fn: (onP: (p: TxProgress) => void) => Promise<T>, bountyId?: bigint): Promise<T | undefined> {
  const id = ++tid;
  let last: Toast = { id, chainId, title, stage: 'wallet', label: 'Waiting for your wallet…' };
  upsertToast(last);
  const onP = (p: TxProgress) => {
    // keep our friendly title; stage-specific label is chosen in the toast component
    last = { ...last, ...p, title, hash: p.hash ?? last.hash };
    upsertToast(last);
  };
  try {
    const r = await fn(onP);
    if (last.stage !== 'confirmed') upsertToast({ ...last, stage: 'confirmed' });
    if (bountyId !== undefined) getReader(chainId).invalidate(bountyId);
    bumpRefresh();
    return r;
  } catch (e) {
    if (e instanceof NeedWallet) { dismissToast(id); return undefined; }
    upsertToast({ ...last, stage: 'failed', error: friendlyError(e) });
    return undefined;
  }
}

export const explorerTx = (base: string, h: Hex) => `${base}/tx/${h}`;
