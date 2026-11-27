import { Component, type ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { StateName } from '@madbounty/sdk';
import type { VerifierKind } from '../types';
import { CHAINS, relTime, shortAddr, stateLabel, usdc, utc, verifierKindLabel } from './deps';
import { useChain } from './store';
import { useNow } from './hooks';
import * as Icon from './icons';

// ---------------------------------------------------------------- Money
/** USDC amount with unit. `hero` = the big reward number. */
export function Money({ v, size = 'md', unit = true, sign }: { v: bigint; size?: 'sm' | 'md' | 'lg' | 'hero'; unit?: boolean; sign?: '+' | '-' }) {
  const s = usdc(v);
  const [whole, cents] = s.split('.');
  return (
    <span class={`money money-${size}`} aria-label={`${sign === '-' ? 'minus ' : ''}${s} USDC`}>
      <span aria-hidden="true">
        {sign && <span class="money-sign">{sign}</span>}
        {whole}<span class="money-cents">.{cents}</span>
        {unit && <span class="money-unit"> USDC</span>}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- StatePill
const TONE: Record<string, string> = { Open: 'accent', Claimed: 'gold', Submitted: 'gold', Rejected: 'danger', Paid: 'green', Burned: 'danger', Refunded: 'muted', Cancelled: 'muted', None: 'muted' };
export function StatePill({ state }: { state: StateName }) {
  return <span class={`spill tone-${TONE[state] ?? 'muted'}`}><span class="spill-dot" aria-hidden="true" />{stateLabel(state)}</span>;
}

export function KindChip({ kind }: { kind: VerifierKind }) {
  return <span class="chip" title="Who decides if the work is good">{kindIcon(kind)}{verifierKindLabel(kind)}</span>;
}
function kindIcon(k: VerifierKind) {
  if (k === 'self' || k === 'eoa') return <Icon.User size={13} />;
  if (k === 'teeML') return <Icon.Sparkle size={13} />;
  return <Icon.Shield size={13} />;
}

// ---------------------------------------------------------------- time
export function When({ t, prefix }: { t: number; prefix?: string }) {
  const now = useNow();
  return <time dateTime={new Date(t * 1000).toISOString()} title={utc(t)}>{prefix}{relTime(t, now)}</time>;
}

/** Relative countdown, refreshed every 30s by the shared clock. */
export function Countdown({ to, label, urgentUnder = 6 * 3600 }: { to: number; label?: string; urgentUnder?: number }) {
  const now = useNow();
  const left = to - now;
  const cls = left <= 0 ? 'cd cd-past' : label === 'until burn' ? 'cd cd-danger' : left < urgentUnder ? 'cd cd-urgent' : 'cd';
  return (
    <span class={cls} title={utc(to)}>
      <Icon.Clock size={14} />
      {label && <span class="cd-label">{label}</span>}
      <time dateTime={new Date(to * 1000).toISOString()}>{left <= 0 ? `ended ${relTime(to, now)}` : relTime(to, now).replace(/^in /, '') + ' left'}</time>
    </span>
  );
}

// ---------------------------------------------------------------- copy
export function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" class="icon-btn" aria-label={copied ? 'Copied' : `Copy ${label}`} title={`Copy ${label}`}
      onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } }}>
      {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
    </button>
  );
}

// ---------------------------------------------------------------- Addr
export function Addr({ a, label, you }: { a: string; label?: string; you?: boolean }) {
  const chain = useChain();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(a); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <span class="addrx">
      <a class="mono" href={`${CHAINS[chain].explorer}/address/${a}`} target="_blank" rel="noopener" title={`${a} — view on Basescan`}>
        {shortAddr(a)}
      </a>
      {you && <span class="you">you</span>}
      <button type="button" class="icon-btn" onClick={copy} aria-label={copied ? 'Copied' : `Copy ${label ?? 'address'}`} title="Copy address">
        {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
      </button>
    </span>
  );
}

export function TxLink({ hash, children, label }: { hash: string; children?: ComponentChildren; label?: string }) {
  const chain = useChain();
  return (
    <a class="txlink" href={`${CHAINS[chain].explorer}/tx/${hash}`} target="_blank" rel="noopener" aria-label={label} title={`${hash} — view on Basescan`}>
      {children ?? <span class="mono">{shortAddr(hash)}</span>}<Icon.External size={12} />
    </a>
  );
}

// ---------------------------------------------------------------- EmptyState / Skeleton / Notice
export function EmptyState({ title, children, icon, action }: { title: string; children?: ComponentChildren; icon?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="empty">
      <div class="empty-ic" aria-hidden="true">{icon ?? <Icon.Inbox size={22} />}</div>
      <h3>{title}</h3>
      {children && <div class="empty-body">{children}</div>}
      {action && <div class="empty-act">{action}</div>}
    </div>
  );
}
export function Skeleton({ h = 16, w = '100%', r = 8 }: { h?: number; w?: number | string; r?: number }) {
  return <span class="sk" style={{ height: `${h}px`, width: typeof w === 'number' ? `${w}px` : w, borderRadius: `${r}px` }} aria-hidden="true" />;
}
export function CardSkeleton() {
  return (
    <div class="bcard bcard-sk" aria-hidden="true">
      <div class="bc-top"><Skeleton h={22} w={86} r={999} /><Skeleton h={14} w={70} /></div>
      <Skeleton h={18} w="85%" /><Skeleton h={18} w="55%" />
      <div style={{ marginTop: 'auto' }}><Skeleton h={34} w={130} /></div>
    </div>
  );
}
export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: string; children?: ComponentChildren }) {
  const ic = tone === 'ok' ? <Icon.ShieldCheck size={18} /> : tone === 'info' ? <Icon.Info size={18} /> : <Icon.Alert size={18} />;
  return (
    <div class={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span class="notice-ic" aria-hidden="true">{ic}</span>
      <div>{title && <strong>{title} </strong>}{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Button
export function Btn({ kind = 'primary', size, busy, disabled, onClick, href, children, type = 'button', full, label }: {
  kind?: 'primary' | 'ghost' | 'danger' | 'quiet'; size?: 'sm' | 'lg'; busy?: boolean; disabled?: boolean; full?: boolean;
  onClick?: (e: MouseEvent) => void; href?: string; children: ComponentChildren; type?: 'button' | 'submit'; label?: string;
}) {
  const cls = `btn b-${kind}${size ? ` btn-${size}` : ''}${full ? ' btn-full' : ''}${busy ? ' is-busy' : ''}`;
  if (href) return <a class={cls} href={href} aria-label={label} onClick={onClick}>{children}</a>;
  return (
    <button type={type} class={cls} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick} aria-label={label}>
      {busy && <Icon.Spinner size={16} />}{children}
    </button>
  );
}

// ---------------------------------------------------------------- ErrorBoundary
export class ErrorBoundary extends Component<{ children: ComponentChildren }, { err?: string }> {
  state: { err?: string } = {};
  static getDerivedStateFromError(e: unknown) { return { err: e instanceof Error ? e.message : String(e) }; }
  componentDidCatch(e: unknown) { console.error(e); }
  render() {
    if (this.state.err) {
      return (
        <div class="wrap page">
          <EmptyState title="Something broke on this page" icon={<Icon.Alert size={22} />}
            action={<Btn kind="ghost" onClick={() => { this.setState({ err: undefined }); location.hash = '#/'; }}>Back to bounties</Btn>}>
            <p>Your funds are safe: nothing here can move money without your wallet. Reload the page, or report it on GitHub.</p>
            <p class="mono small muted">{this.state.err}</p>
          </EmptyState>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------- focus trap (used by modals)
export function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])') ?? []);
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables(); if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); prev?.focus?.(); };
  }, [open]);
  return ref;
}

export function Modal({ open, onClose, title, children, labelledBy = 'modal-title', wide }: { open: boolean; onClose: () => void; title: string; children: ComponentChildren; labelledBy?: string; wide?: boolean }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  // Portal to <body>: sticky ancestors create stacking contexts that would trap the overlay under the header.
  return createPortal(
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`sheet${wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <div class="sheet-head">
          <h2 id={labelledBy}>{title}</h2>
          <button type="button" class="icon-btn sheet-x" onClick={onClose} aria-label="Close"><Icon.X size={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
