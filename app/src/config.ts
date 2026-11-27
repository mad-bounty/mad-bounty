// Chains, RPCs, deployments and app constants. Addresses come from @madbounty/sdk DEPLOYMENTS.
import type { Address, Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { DEPLOYMENTS } from '@madbounty/sdk';
import type { ChainId } from './types';

export interface AdapterAddresses {
  fallback: Address;
  onchainCheck: Address;
  hashReveal: Address;
  teeML: Address;
  multi: Address;
}

export interface ChainConfig {
  id: ChainId;
  name: string;
  testnet: boolean;
  rpc: string;
  explorer: string;
  usdc: Address;
  core: Address;
  deployBlock: bigint;
  adapters: AdapterAddresses;
  reputation?: { receipts: Address; attest: Address };
  viemChain: Chain;
}

function build(id: ChainId, name: string, rpc: string, explorer: string, viemChain: Chain, testnet: boolean): ChainConfig {
  const d = DEPLOYMENTS[id];
  return {
    id, name, testnet, rpc, explorer,
    usdc: d.usdc as Address,
    core: d.core as Address,
    deployBlock: d.deployBlock,
    adapters: { ...d.verifiers } as AdapterAddresses,
    reputation: d.reputation ? { ...d.reputation } as { receipts: Address; attest: Address } : undefined,
    viemChain,
  };
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  8453: build(8453, 'Base', 'https://base-rpc.publicnode.com', 'https://basescan.org', base, false),
  84532: build(84532, 'Base Sepolia', 'https://base-sepolia-rpc.publicnode.com', 'https://sepolia.basescan.org', baseSepolia, true),
};

export const DEFAULT_CHAIN: ChainId = 8453;
export const SUPPORTED_CHAIN_IDS: ChainId[] = [8453, 84532];
export function isSupportedChain(id: number | undefined | null): id is ChainId {
  return id === 8453 || id === 84532;
}

/** Max blocks per eth_getLogs request (publicnode caps at 50k). */
export const LOG_CHUNK = 45_000n;
/** Marker appended to post() calldata before the spec JSON bytes. */
export const SPEC_MAGIC = 'MADBSPEC1';
/** Spec JSON byte cap (UTF-8). */
export const SPEC_MAX_BYTES = 16_384;
/** Read-cache TTL in ms. */
export const CACHE_TTL_MS = 15_000;

export const txUrl = (chainId: ChainId, hash: string) => `${CHAINS[chainId].explorer}/tx/${hash}`;
export const addressUrl = (chainId: ChainId, addr: string) => `${CHAINS[chainId].explorer}/address/${addr}`;
