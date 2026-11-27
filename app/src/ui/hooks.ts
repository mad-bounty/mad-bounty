import { useEffect, useRef, useState } from 'preact/hooks';
import { createStore, refreshStore, useStore } from './store';

// ---------- shared clock: one interval for every countdown (30s)
const nowStore = createStore(Math.floor(Date.now() / 1000));
let clock: ReturnType<typeof setInterval> | undefined;
export function useNow(): number {
  useEffect(() => {
    if (!clock) clock = setInterval(() => nowStore.set(Math.floor(Date.now() / 1000)), 30_000);
  }, []);
  return useStore(nowStore);
}

// ---------- hash router
export interface Route { name: 'browse' | 'bounty' | 'post' | 'me' | 'help' | 'notfound'; id?: bigint; query: URLSearchParams }
export function parseHash(h: string): Route {
  const raw = h.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const query = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'browse', query };
  if (parts[0] === 'bounty' && parts[1] && /^\d+$/.test(parts[1])) return { name: 'bounty', id: BigInt(parts[1]), query };
  if (parts[0] === 'post') return { name: 'post', query };
  if (parts[0] === 'me') return { name: 'me', query };
  if (parts[0] === 'help') return { name: 'help', query };
  return { name: 'notfound', query };
}
export function useRoute(): Route {
  const [r, setR] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setR(parseHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}

// ---------- async loader with refetch on refreshStore bumps
export interface Async<T> { data?: T; error?: string; loading: boolean; reload: () => void }
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const refresh = useStore(refreshStore);
  const [n, setN] = useState(0);
  const [s, setS] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setS((p) => ({ data: p.data, loading: true }));
    fn().then(
      (data) => { if (my === seq.current) setS({ data, loading: false }); },
      (e) => { if (my === seq.current) setS({ error: e instanceof Error ? e.message : String(e), loading: false }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refresh, n]);
  return { ...s, reload: () => setN((x) => x + 1) };
}

/** Clear stale data when the key changes (e.g. chain switch) so we never show mainnet data under a testnet header. */
export function useKeyed<T>(key: string, a: Async<T>): Async<T> {
  const k = useRef(key);
  const [stale, setStale] = useState(false);
  useEffect(() => { if (k.current !== key) { k.current = key; setStale(true); } }, [key]);
  useEffect(() => { if (!a.loading) setStale(false); }, [a.loading]);
  return stale ? { ...a, data: undefined } : a;
}

export function usePrefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
