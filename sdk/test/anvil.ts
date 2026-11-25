// Test harness: start anvil on a random port, deploy MockUSDC + MADBountyCore from forge artifacts.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  createPublicClient, createTestClient, createWalletClient, http, parseAbi,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Default anvil mnemonic keys (test only).
export const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  worker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  verifier: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  keeper: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  treasury: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
} as const satisfies Record<string, Hex>;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

function artifact(rel: string): { abi: unknown[]; bytecode: Hex } {
  const p = join(REPO, 'out', rel);
  if (!existsSync(p)) throw new Error(`missing forge artifact ${p}; run \`forge build\` in ${REPO}`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

export const mockUsdcAbi = parseAbi([
  'function mint(address to, uint256 a)',
  'function blacklist(address a)',
  'function balanceOf(address) view returns (uint256)',
]);

export interface Chain {
  rpcUrl: string;
  chainId: number;
  core: Address;
  usdc: Address;
  treasury: Address;
  proc: ChildProcess;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  wallet: (key: Hex) => ReturnType<typeof createWalletClient>;
  increaseTime: (seconds: number) => Promise<void>;
  mint: (to: Address, amount: bigint) => Promise<void>;
  stop: () => Promise<void>;
}

export async function startChain(): Promise<Chain> {
  const anvilBin = process.env.ANVIL_BIN ?? join(homedir(), '.foundry', 'bin', 'anvil');
  const port = await freePort();
  const proc = spawn(anvilBin, ['--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
  const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  for (let i = 0; ; i++) {
    try { await publicClient.getChainId(); break; } catch (e) {
      if (i > 100) { proc.kill(); throw new Error(`anvil did not start: ${(e as Error).message}`); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wallet = (key: Hex) => createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(key) });
  const deployer = wallet(KEYS.deployer);
  const treasury = privateKeyToAccount(KEYS.treasury).address;

  const deploy = async (rel: string, args: unknown[]) => {
    const a = artifact(rel);
    const hash = await deployer.deployContract({ abi: a.abi as never, bytecode: a.bytecode, args: args as never });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`deploy failed ${rel}`);
    return r.contractAddress;
  };
  const usdc = await deploy('MADBountyCore.t.sol/MockUSDC.json', []);
  const core = await deploy('MADBountyCore.sol/MADBountyCore.json', [
    usdc, treasury, 'ipfs://test/llms.txt', '0x' + '11'.repeat(32),
  ]);

  return {
    rpcUrl, chainId: 31337, core, usdc, treasury, proc, publicClient, testClient, wallet,
    async increaseTime(seconds: number) {
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
    async mint(to: Address, amount: bigint) {
      const hash = await deployer.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: 'mint', args: [to, amount] });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
