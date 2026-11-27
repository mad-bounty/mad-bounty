// Inline SVG icons (stroke style matching the site). Decorative by default.
import type { JSX } from 'preact';

type P = { size?: number; class?: string; title?: string };
function I({ size = 18, class: cls, title, children }: P & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : <g />}
      {children}
    </svg>
  );
}
export const Logo = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="24" height="24" rx="7" stroke="#2e9bff" stroke-width="2" />
    <path d="M7 16.5v-4a2.5 2.5 0 0 1 5 0v4" stroke="#eef2f7" stroke-width="2" stroke-linecap="round" />
    <path d="M14 16.5v-4a2.5 2.5 0 0 1 5 0v4" stroke="#eef2f7" stroke-width="2" stroke-linecap="round" />
  </svg>
);
export const Copy = (p: P) => <I {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></I>;
export const Check = (p: P) => <I {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></I>;
export const X = (p: P) => <I {...p}><path d="M6 6l12 12M18 6L6 18" /></I>;
export const External = (p: P) => <I {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></I>;
export const Clock = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></I>;
export const Shield = (p: P) => <I {...p}><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" /></I>;
export const ShieldCheck = (p: P) => <I {...p}><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></I>;
export const Alert = (p: P) => <I {...p}><path d="M12 3l9.5 17h-19L12 3z" /><path d="M12 10v4M12 17.5v.01" /></I>;
export const Info = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" /></I>;
export const Wallet = (p: P) => <I {...p}><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M16 15h.01" /><path d="M6 6l9-3 1.5 3" /></I>;
export const Plus = (p: P) => <I {...p}><path d="M12 5v14M5 12h14" /></I>;
export const Arrow = (p: P) => <I {...p}><path d="M5 12h14M13 6l6 6-6 6" /></I>;
export const Back = (p: P) => <I {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></I>;
export const Spinner = ({ size = 18 }: P) => (
  <svg class="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
  </svg>
);
export const Doc = (p: P) => <I {...p}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></I>;
export const Flame = (p: P) => <I {...p}><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5.5.8 1.3 1.5 2 2.5 2.2C11.5 7.5 11.5 5 12 3z" /></I>;
export const Coins = (p: P) => <I {...p}><ellipse cx="9" cy="7" rx="6" ry="3" /><path d="M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7" /><path d="M9 17c0 1.7 2.7 3 6 3s6-1.3 6-3v-4c0-1.6-2.4-2.9-5.5-3" /></I>;
export const User = (p: P) => <I {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6" /></I>;
export const Search = (p: P) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></I>;
export const Chevron = (p: P) => <I {...p}><path d="M9 6l6 6-6 6" /></I>;
export const Trash = (p: P) => <I {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></I>;
export const Sparkle = (p: P) => <I {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></I>;
