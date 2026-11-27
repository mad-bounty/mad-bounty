// Injected wallets only: EIP-6963 discovery with window.ethereum fallback, viem WalletClient signer.
import { createWalletClient, custom, getAddress, numberToHex, type Address, type WalletClient } from 'viem';
import { CHAINS, isSupportedChain } from '../config';
import type { ChainId } from '../types';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

export interface ProviderInfo {
  uuid: string;
  name: string;
  icon: string;   // data URI
  rdns: string;
  provider: Eip1193Provider;
}

export interface WalletState {
  providers: ProviderInfo[];
  connected?: ProviderInfo;
  address?: Address;
  chainId?: number;
  /** true when chainId is 8453 or 84532 */
  supported: boolean;
  walletClient?: WalletClient;
  connecting: boolean;
  error?: string;
}

// ------------------------------------------------------------------ tiny observable store
type Listener<T> = (s: T) => void;
export interface Store<T> { get(): T; set(patch: Partial<T>): void; subscribe(fn: Listener<T>): () => void }

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<Listener<T>>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of [...subs]) { try { fn(state); } catch { /* listener errors must not break others */ } }
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

export const walletStore = createStore<WalletState>({ providers: [], supported: false, connecting: false });

// ------------------------------------------------------------------ discovery
const win = (): any => (typeof window !== 'undefined' ? window : undefined);
let discovering = false;

function addProvider(p: ProviderInfo) {
  const list = walletStore.get().providers;
  if (list.some((x) => x.uuid === p.uuid || x.provider === p.provider)) return;
  walletStore.set({ providers: [...list, p] });
}

/** Start EIP-6963 discovery (idempotent). Falls back to window.ethereum after a short wait. */
export function discoverWallets(fallbackDelayMs = 300): void {
  const w = win();
  if (!w || discovering) return;
  discovering = true;
  w.addEventListener('eip6963:announceProvider', (ev: Event) => {
    const d = (ev as CustomEvent).detail as { info?: Omit<ProviderInfo, 'provider'>; provider?: Eip1193Provider } | undefined;
    if (!d?.info || !d.provider) return;
    addProvider({ ...d.info, provider: d.provider });
  });
  w.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => {
    if (walletStore.get().providers.length === 0 && w.ethereum) {
      const eth = w.ethereum as Eip1193Provider & { isMetaMask?: boolean; isCoinbaseWallet?: boolean; isRabby?: boolean };
      const name = eth.isRabby ? 'Rabby' : eth.isCoinbaseWallet ? 'Coinbase Wallet' : eth.isMetaMask ? 'MetaMask' : 'Browser wallet';
      addProvider({ uuid: 'window.ethereum', name, icon: '', rdns: 'injected', provider: eth });
    }
  }, fallbackDelayMs);
}

export const hasAnyWallet = () => walletStore.get().providers.length > 0 || !!win()?.ethereum;

// ------------------------------------------------------------------ connect
let detach: (() => void) | undefined;

function makeClient(p: Eip1193Provider, address: Address, chainId: number): WalletClient {
  const chain = isSupportedChain(chainId) ? CHAINS[chainId].viemChain : undefined;
  return createWalletClient({ account: address, chain, transport: custom(p as any) });
}

function attach(info: ProviderInfo) {
  detach?.();
  const p = info.provider;
  const onAccounts = (accs: string[]) => {
    if (!accs || accs.length === 0) { disconnect(); return; }
    const address = getAddress(accs[0]!);
    const chainId = walletStore.get().chainId ?? 0;
    walletStore.set({ address, walletClient: makeClient(p, address, chainId) });
  };
  const onChain = (hex: string) => {
    const chainId = Number(hex);
    const address = walletStore.get().address;
    walletStore.set({ chainId, supported: isSupportedChain(chainId), walletClient: address ? makeClient(p, address, chainId) : undefined });
  };
  const onDisconnect = () => disconnect();
  p.on?.('accountsChanged', onAccounts);
  p.on?.('chainChanged', onChain);
  p.on?.('disconnect', onDisconnect);
  detach = () => {
    p.removeListener?.('accountsChanged', onAccounts);
    p.removeListener?.('chainChanged', onChain);
    p.removeListener?.('disconnect', onDisconnect);
  };
}

export interface Connection { address: Address; chainId: number; walletClient: WalletClient }

/** Ask the wallet for accounts (opens the wallet popup). */
export async function connect(info: ProviderInfo): Promise<Connection> {
  walletStore.set({ connecting: true, error: undefined });
  try {
    const accs = (await info.provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accs?.length) throw new Error('No account was shared by the wallet.');
    const address = getAddress(accs[0]!);
    const chainId = Number(await info.provider.request({ method: 'eth_chainId' }));
    const walletClient = makeClient(info.provider, address, chainId);
    attach(info);
    walletStore.set({ connected: info, address, chainId, supported: isSupportedChain(chainId), walletClient, connecting: false });
    try { sessionStorage.setItem('madb:wallet', info.rdns || info.uuid); } catch { /* no storage */ }
    return { address, chainId, walletClient };
  } catch (e) {
    walletStore.set({ connecting: false, error: (e as Error)?.message });
    throw e;
  }
}

/** Reconnect silently (eth_accounts, no popup) to the wallet used earlier in this tab, if any. */
export async function reconnect(): Promise<Connection | undefined> {
  let key: string | null = null;
  try { key = sessionStorage.getItem('madb:wallet'); } catch { /* ignore */ }
  if (!key) return undefined;
  const info = walletStore.get().providers.find((p) => p.rdns === key || p.uuid === key);
  if (!info) return undefined;
  const accs = (await info.provider.request({ method: 'eth_accounts' }).catch(() => [])) as string[];
  if (!accs?.length) return undefined;
  return connect(info);
}

export function disconnect(): void {
  detach?.();
  detach = undefined;
  try { sessionStorage.removeItem('madb:wallet'); } catch { /* ignore */ }
  walletStore.set({ connected: undefined, address: undefined, chainId: undefined, supported: false, walletClient: undefined, connecting: false });
}

/** Switch the wallet to chainId; add the chain first if the wallet doesn't know it (4902). */
export async function ensureChain(chainId: ChainId, provider?: Eip1193Provider): Promise<void> {
  const p = provider ?? walletStore.get().connected?.provider;
  if (!p) throw new Error('No wallet connected. Connect a wallet first.');
  const current = Number(await p.request({ method: 'eth_chainId' }));
  if (current === chainId) return;
  const hex = numberToHex(chainId);
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } })?.code
      ?? (e as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
    if (code !== 4902 && !/unrecognized chain|not been added|4902/i.test(String((e as Error)?.message))) throw e;
    const c = CHAINS[chainId];
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex,
        chainName: c.name,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [c.rpc],
        blockExplorerUrls: [c.explorer],
      }],
    });
  }
  const after = Number(await p.request({ method: 'eth_chainId' }));
  const address = walletStore.get().address;
  walletStore.set({ chainId: after, supported: isSupportedChain(after), walletClient: address ? makeClient(p, address, after) : undefined });
  if (after !== chainId) throw new Error(`Your wallet is still on another network. Switch to ${CHAINS[chainId].name} and try again.`);
}

/** Test hook: reset module state. */
export function _resetWalletForTests(): void {
  detach?.(); detach = undefined; discovering = false;
  walletStore.set({ providers: [], connected: undefined, address: undefined, chainId: undefined, supported: false, walletClient: undefined, connecting: false, error: undefined });
}
