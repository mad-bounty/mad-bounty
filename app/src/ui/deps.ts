// Single import point from the UI into chain/* and model/* (the real modules).
// The UI never imports viem or the chain layer directly except through here.
import { usdcShort } from '../model/format';

export { CHAINS } from '../config';
export { walletStore as wallet, discoverWallets, connect, disconnect, ensureChain, reconnect } from '../chain/wallet';
export type { ProviderInfo as DiscoveredWallet, WalletState } from '../chain/wallet';
export { createReader, type Reader } from '../chain/reads';
export { createWriter, type Writer } from '../chain/writes';
export { friendlyError } from '../chain/errors';
export { availableActions, nextStep } from '../model/actions';
export { defaultForm, derive, buildSpecJson, buildPostParams, describe, type PostCtx } from '../model/postForm';
export { shortAddr, duration, relTime, utc, verifierKindLabel, stateLabel } from '../model/format';

/** Bare amount for display next to a separate "USDC" unit: '1,035.00' (keeps sub-cent precision, never rounds). */
export function usdc(units: bigint): string {
  const [w, f] = usdcShort(units).split('.');
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}
