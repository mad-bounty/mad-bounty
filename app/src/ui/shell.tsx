// App chrome: site header/nav, app tabs, chain toggle, testnet banner, wallet button, footer, toasts, wallet picker.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChainId } from '../types';
import { CHAINS, connect, disconnect, ensureChain, shortAddr, friendlyError, type DiscoveredWallet } from './deps';
import { dismissToast, openWalletPicker, setChain, toastStore, useChain, useStore, useWallet, walletPickerOpen } from './store';
import type { Route } from './hooks';
import { Btn, Modal, Notice } from './components';
import * as Icon from './icons';

const SITE_LINKS = [
  ['/#how', 'How it works'], ['/docs', 'Docs'], ['/agents', 'For agents'], ['/explorer/', 'Explorer'],
  ['https://github.com/mad-bounty/mad-bounty', 'GitHub'],
] as const;

const TABS: { name: Route['name']; href: string; label: string; short: string; icon: (p: { size?: number }) => preact.JSX.Element }[] = [
  { name: 'browse', href: '#/', label: 'Bounties', short: 'Bounties', icon: Icon.Search },
  { name: 'post', href: '#/post', label: 'Post a bounty', short: 'Post', icon: Icon.Plus },
  { name: 'me', href: '#/me', label: 'My bounties', short: 'Mine', icon: Icon.User },
  { name: 'help', href: '#/help', label: 'Help', short: 'Help', icon: Icon.Info },
];

export function AppShell({ route, children }: { route: Route; children: ComponentChildren }) {
  const chain = useChain();
  const active = route.name === 'bounty' ? 'browse' : route.name;
  return (
    <>
      <a class="skip" href="#main">Skip to content</a>
      <header>
        <div class="wrap nav">
          <a class="brand" href="/"><Icon.Logo />MAD&nbsp;Bounty</a>
          <nav class="links" aria-label="Site">
            {SITE_LINKS.map(([h, t]) => <a href={h}>{t}</a>)}
          </nav>
          <div class="nav-right"><span class="chain-m"><ChainToggle /></span><WalletButton /></div>
        </div>
        <div class="appbar">
          <div class="wrap appbar-in">
            <nav class="tabs" aria-label="App">
              {TABS.map((t) => (
                <a href={t.href} class={`tab${active === t.name ? ' on' : ''}`} aria-current={active === t.name ? 'page' : undefined}>{t.label}</a>
              ))}
            </nav>
            <span class="appbar-label">Network</span>
            <ChainToggle />
          </div>
        </div>
      </header>
      {chain === 84532 && (
        <div class="testnet-banner" role="status">
          <div class="wrap">
            <Icon.Alert size={16} />
            <span><strong>Testnet</strong> · Base Sepolia. Test USDC only, no real value.</span>
          </div>
        </div>
      )}
      <main id="main" tabIndex={-1}>{children}</main>
      <Footer chain={chain} />
      <nav class="tabbar" aria-label="App (mobile)">
        {TABS.map((t) => (
          <a href={t.href} class={active === t.name ? 'on' : ''} aria-current={active === t.name ? 'page' : undefined}>
            <t.icon size={20} /><span>{t.short}</span>
          </a>
        ))}
      </nav>
      <ToastStack />
      <WalletPicker />
    </>
  );
}

export function ChainToggle() {
  const chain = useChain();
  const opt = (id: ChainId, label: string) => (
    <button type="button" role="radio" aria-checked={chain === id} class={chain === id ? 'on' : ''} onClick={() => setChain(id)}>
      {label}
    </button>
  );
  return (
    <div class={`seg seg-chain${chain === 84532 ? ' is-test' : ''}`} role="radiogroup" aria-label="Network">
      {opt(8453, 'Base')}{opt(84532, 'Base Sepolia')}
    </div>
  );
}

function Jazz({ a }: { a: string }) {
  // deterministic two-tone dot from the address (no lib)
  const h1 = parseInt(a.slice(2, 6), 16) % 360, h2 = parseInt(a.slice(-4), 16) % 360;
  return <span class="jazz" aria-hidden="true" style={{ background: `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))` }} />;
}

export function WalletButton() {
  const w = useWallet();
  const chain = useChain();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const on = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', on); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', on); document.removeEventListener('keydown', key); };
  }, [menu]);

  if (!w.address) {
    return <button type="button" class="btn b-primary btn-sm wbtn" onClick={openWalletPicker}><Icon.Wallet size={16} /><span>Connect<span class="wbtn-xl"> wallet</span></span></button>;
  }
  if (w.chainId !== undefined && w.chainId !== chain) {
    return (
      <button type="button" class="btn b-gold btn-sm wbtn" disabled={busy} onClick={async () => { setBusy(true); try { await ensureChain(chain); } catch { /* wallet shows it */ } setBusy(false); }}>
        {busy ? <Icon.Spinner size={16} /> : <Icon.Alert size={16} />}Switch to {chain === 84532 ? 'Base Sepolia' : 'Base'}
      </button>
    );
  }
  return (
    <div class="wmenu" ref={ref}>
      <button type="button" class="btn b-ghost btn-sm wbtn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
        <Jazz a={w.address} /><span class="mono">{shortAddr(w.address)}</span>
      </button>
      {menu && (
        <div class="popover" role="menu">
          <div class="pop-head"><span class="muted small">Connected to {CHAINS[chain].name}</span><span class="mono small">{shortAddr(w.address)}</span></div>
          <a role="menuitem" href="#/me" onClick={() => setMenu(false)}><Icon.User size={16} />My bounties</a>
          <button role="menuitem" type="button" onClick={() => { navigator.clipboard?.writeText(w.address!); setMenu(false); }}><Icon.Copy size={16} />Copy address</button>
          <a role="menuitem" href={`${CHAINS[chain].explorer}/address/${w.address}`} target="_blank" rel="noopener"><Icon.External size={16} />View on Basescan</a>
          <button role="menuitem" type="button" class="danger" onClick={() => { disconnect(); setMenu(false); }}><Icon.X size={16} />Disconnect</button>
        </div>
      )}
    </div>
  );
}

function isMobile() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || matchMedia('(max-width: 640px)').matches; }

export function WalletPicker() {
  const open = useStore(walletPickerOpen);
  const w = useWallet();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const close = () => { walletPickerOpen.set(false); setErr(undefined); setBusy(undefined); };
  const pick = async (p: DiscoveredWallet) => {
    setBusy(p.uuid); setErr(undefined);
    try { await connect(p); close(); } catch (e) { setErr(friendlyError(e)); setBusy(undefined); }
  };
  const here = typeof location !== 'undefined' ? `${location.host}${location.pathname}` : 'madbounty.org/app/';
  return (
    <Modal open={open} onClose={close} title="Connect a wallet" labelledBy="wp-title">
      <div class="sheet-body">
        {w.providers.length > 0 ? (
          <>
            <p class="muted small">Pick the wallet installed in this browser. We never see your keys; every action is signed in your wallet.</p>
            <ul class="wlist">
              {w.providers.map((p) => (
                <li>
                  <button type="button" class="wopt" onClick={() => pick(p)} disabled={!!busy} data-autofocus>
                    {p.icon ? <img src={p.icon} alt="" width={32} height={32} /> : <span class="wopt-ph"><Icon.Wallet size={18} /></span>}
                    <span class="wopt-n">{p.name}</span>
                    {busy === p.uuid ? <Icon.Spinner size={18} /> : <Icon.Chevron size={18} />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div class="nowallet">
            <div class="empty-ic"><Icon.Wallet size={22} /></div>
            <h3>No wallet found</h3>
            <p class="muted">You can still browse every bounty. To post or work one you need a browser wallet that supports Base.</p>
            {isMobile() ? (
              <>
                <p class="small">On a phone, open this page inside your wallet app's built-in browser:</p>
                <div class="deeplinks">
                  <a class="btn b-ghost" href={`https://metamask.app.link/dapp/${here}`}>Open in MetaMask</a>
                  <a class="btn b-ghost" href={`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent('https://' + here)}`}>Open in Coinbase Wallet</a>
                </div>
                <p class="small muted">Using Rabby, Rainbow or another wallet? Copy <span class="mono">{here}</span> into its browser tab.</p>
              </>
            ) : (
              <div class="deeplinks">
                <a class="btn b-ghost" href="https://rabby.io" target="_blank" rel="noopener">Get Rabby</a>
                <a class="btn b-ghost" href="https://metamask.io/download/" target="_blank" rel="noopener">Get MetaMask</a>
                <a class="btn b-ghost" href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener">Get Coinbase Wallet</a>
              </div>
            )}
            <p class="small muted">After installing, reload this page.</p>
          </div>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
      </div>
    </Modal>
  );
}

export function ToastStack() {
  const toasts = useStore(toastStore);
  return (
    <div class="toasts" aria-live="polite" aria-relevant="additions text">
      {toasts.map((t) => {
        const ex = CHAINS[t.chainId].explorer;
        const ic = t.stage === 'confirmed' ? <Icon.Check size={18} /> : t.stage === 'failed' ? <Icon.Alert size={18} /> : <Icon.Spinner size={18} />;
        const msg = t.stage === 'wallet' ? 'Confirm in your wallet…'
          : t.stage === 'submitted' ? `Submitted. Waiting for ${CHAINS[t.chainId].name} to confirm…`
          : t.stage === 'confirmed' ? 'Confirmed on-chain.'
          : t.error ?? 'Failed.';
        return (
          <div class={`toast toast-${t.stage}`} role={t.stage === 'failed' ? 'alert' : 'status'}>
            <span class="toast-ic">{ic}</span>
            <div class="toast-b">
              <strong>{t.title}</strong>
              <span>{msg}</span>
              {t.hash && <a href={`${ex}/tx/${t.hash}`} target="_blank" rel="noopener">View on {t.chainId === 84532 ? 'Sepolia Basescan' : 'Basescan'} <Icon.External size={12} /></a>}
            </div>
            <button type="button" class="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><Icon.X size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}

function Footer({ chain }: { chain: ChainId }) {
  const c = CHAINS[chain];
  return (
    <footer>
      <div class="wrap foot">
        <div class="col">
          <div class="h">Protocol</div>
          <a href="/docs">Documentation</a>
          <a href="/agents">Agent integration</a>
          <a href="/explorer/">Explorer</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
        </div>
        <div class="col">
          <div class="h">Code</div>
          <a href="https://github.com/mad-bounty/mad-bounty">GitHub</a>
          <a href="https://github.com/mad-bounty/mad-bounty/tree/main/sdk">SDK</a>
          <a href="https://github.com/mad-bounty/mad-bounty/tree/main/mcp">MCP server</a>
        </div>
        <div class="col">
          <div class="h">Contracts · {c.name}</div>
          <a class="addr" href={`${c.explorer}/address/${c.core}`} target="_blank" rel="noopener" title={c.core}>Core {shortAddr(c.core)}</a>
          <a class="addr" href={`${c.explorer}/address/${c.usdc}`} target="_blank" rel="noopener" title={c.usdc}>USDC {shortAddr(c.usdc)}</a>
        </div>
        <div class="fine">
          MAD Bounty is a protocol, not a platform: immutable, non-custodial contracts with no admin controls. <strong>Not externally audited</strong> — bugs are permanent, so only escrow what you can afford to lose. This app runs entirely in your browser: no backend, no accounts, no cookies, no analytics. Nothing here is financial advice. USDC is a registered trademark of Circle Internet Financial.
        </div>
      </div>
    </footer>
  );
}
