import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, foundry } from 'viem/chains';
import { BASE_MAINNET_USDC, DEPLOYMENTS, createClient, type MADBountyClient } from '@madbounty/sdk';

export interface ServerConfig {
  rpcUrl: string;
  chainId: number;
  core?: Address;
  usdc: Address;
  privateKey?: Hex;
  knownVerifiers: Address[];
  adapters?: { fallback?: Address; onchainCheck?: Address; hashReveal?: Address; teeML?: Address; multi?: Address };
  trustedSigners: Address[];
  manualPath?: string;
  fromBlock: bigint;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const chainId = Number(env.MADB_CHAIN_ID ?? 8453);
  const dep = (DEPLOYMENTS as Record<number, { core: Address; deployBlock: bigint; usdc: Address; verifiers: Record<string, Address> }>)[chainId];
  const core = env.MADB_CORE && isAddress(env.MADB_CORE) ? getAddress(env.MADB_CORE) : dep?.core;
  const pk = env.MADB_PRIVATE_KEY?.trim();
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('MADB_PRIVATE_KEY must be 0x + 64 hex chars');
  return {
    rpcUrl: env.MADB_RPC_URL ?? (chainId === 84532 ? 'https://sepolia.base.org' : 'https://mainnet.base.org'),
    chainId,
    core,
    usdc: env.MADB_USDC && isAddress(env.MADB_USDC) ? getAddress(env.MADB_USDC) : (dep?.usdc ?? BASE_MAINNET_USDC),
    privateKey: pk as Hex | undefined,
    knownVerifiers: [...new Set([...(env.MADB_KNOWN_VERIFIERS ?? '').split(',').map((s) => s.trim()).filter((s): s is Address => isAddress(s)).map((a) => getAddress(a)), ...Object.values(dep?.verifiers ?? {})])],
    adapters: dep?.verifiers as ServerConfig['adapters'],
    trustedSigners: (env.MADB_TRUSTED_SIGNERS ?? '').split(',').map((s) => s.trim()).filter((s): s is Address => isAddress(s)).map((a) => getAddress(a)),
    manualPath: env.MADB_MANUAL_PATH,
    fromBlock: env.MADB_FROM_BLOCK ? BigInt(env.MADB_FROM_BLOCK) : (dep?.deployBlock ?? 0n),
  };
}

function chainFor(id: number, rpcUrl: string) {
  const known = [base, baseSepolia, foundry].find((c) => c.id === id);
  if (known) return { ...known, rpcUrls: { default: { http: [rpcUrl] } } };
  return defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } } });
}

export interface Runtime {
  cfg: ServerConfig;
  /** throws a helpful error when MADB_CORE is missing */
  client: () => MADBountyClient;
  signer?: Address;
}

export function makeRuntime(cfg: ServerConfig): Runtime {
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const transport = http(cfg.rpcUrl);
  const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
  let cached: MADBountyClient | undefined;
  return {
    cfg,
    signer: account?.address,
    client() {
      if (!cfg.core) throw new Error('MADB_CORE is not set. MAD Bounty core is not deployed on this chain yet, or the server is misconfigured.');
      if (!cached) {
        const publicClient = createPublicClient({ chain, transport, pollingInterval: 200 });
        const walletClient = account ? createWalletClient({ chain, transport, account }) : undefined;
        cached = createClient({ publicClient: publicClient as never, walletClient: walletClient as never, core: cfg.core, usdc: cfg.usdc });
      }
      return cached;
    },
  };
}
