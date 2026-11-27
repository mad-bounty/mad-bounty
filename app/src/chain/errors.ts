// Revert selector / wallet error → plain-English sentence. Never surface raw hex to users.
import { BaseError, ContractFunctionRevertedError, parseAbi, toFunctionSelector, type Abi, type Hex } from 'viem';
import { madBountyCoreAbi } from '@madbounty/sdk';

/** Custom errors declared by the periphery adapters (AdapterBase + each adapter). */
export const adapterErrorsAbi = parseAbi([
  'error BadConfig()', 'error NotAgent()', 'error NotVerifier()', 'error NotOpen()', 'error NotSubmitted()',
  'error AlreadyConfigured()', 'error NotConfigured()', 'error NotCore()', 'error TooEarly()',
  'error BadIndex()', 'error BadSig()',                                  // Fallback
  'error CheckFailed()', 'error CheckPasses()', 'error LowGas()',         // OnchainCheck
  'error NotWorker()', 'error WrongAnswer()',                             // HashReveal
  'error BadSigner()', 'error BadTemplate()', 'error BadMarker()', 'error BadEvidence()', 'error NoVerdict()', // TeeML
  'error NotSorted()', 'error UnknownSigner()', 'error BelowThreshold()', // Multi
  'error StringsInsufficientHexLength(uint256 value, uint256 length)',
]);

/** USDC (FiatToken) reverts with Error(string); OZ ERC20 custom errors kept for other tokens. */
const tokenErrorsAbi = parseAbi([
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
]);

/** Every custom error any app call can hit, for viem decoding. */
export const allErrorsAbi = [
  ...(madBountyCoreAbi as Abi).filter((x) => x.type === 'error'),
  ...adapterErrorsAbi,
  ...tokenErrorsAbi,
] as Abi;

export const ERROR_MESSAGES: Record<string, string> = {
  // MADBountyCore
  BadParam: 'Invalid parameters: check the amounts, windows and addresses (reward 1–1000 USDC, deposit ≥ the minimum and ≤ the reward).',
  BadState: 'This bounty is not in the right state for that action (it may have changed — refresh).',
  NotAllowed: 'Your address is not allowed to do that on this bounty.',
  TooEarly: 'Too early: this becomes available later.',
  TooLate: 'Too late: the window for this action has passed.',
  BadSig: 'The signature is not valid for this action.',
  TransferFailed: 'The USDC transfer failed. Check your USDC balance and approval.',
  ReentrancyGuardReentrantCall: 'The contract refused a nested call.',
  InsufficientBalance: 'Not enough ETH for this operation.',
  FailedDeployment: 'Creating the bounty vault failed. Try again.',
  InvalidShortString: 'Internal contract error (invalid string).',
  StringTooLong: 'Internal contract error (string too long).',
  // Adapters
  BadConfig: 'The verifier configuration is invalid (check signers, windows and template).',
  NotAgent: 'Only the bounty’s agent can configure its verifier.',
  NotVerifier: 'This adapter is not the verifier of that bounty.',
  NotOpen: 'The verifier can only be configured while the bounty is open.',
  NotSubmitted: 'Nothing to verify yet: work has not been submitted (or the verdict is already in).',
  AlreadyConfigured: 'The verifier for this bounty is already configured.',
  NotConfigured: 'The verifier for this bounty was never configured.',
  NotCore: 'Only the MAD Bounty core contract can call this.',
  BadIndex: 'That signer is not active yet in the fallback ladder (or the index is wrong).',
  CheckFailed: 'The on-chain check does not pass yet, so it cannot be resolved as accepted.',
  CheckPasses: 'The on-chain check passes, so the work cannot be rejected as unmet.',
  LowGas: 'Not enough gas was supplied for the on-chain check. Retry with a higher gas limit.',
  NotWorker: 'Only the worker on this bounty can reveal the answer.',
  WrongAnswer: 'That answer does not match the committed answer.',
  BadSigner: 'The TEE response was not signed by an approved enclave signer.',
  BadTemplate: 'The TEE request does not match the configured prompt template.',
  BadMarker: 'The TEE request does not contain this bounty’s marker.',
  BadEvidence: 'The evidence text is not allowed (too long or contains forbidden content).',
  NoVerdict: 'The TEE response must contain exactly one VERDICT.',
  NotSorted: 'Signers must be listed in ascending address order.',
  UnknownSigner: 'One of the signers is not part of this bounty’s verifier set.',
  BelowThreshold: 'Not enough signatures to reach the threshold.',
  StringsInsufficientHexLength: 'Internal adapter error (hex length).',
  ERC20InsufficientBalance: 'Not enough USDC in your wallet.',
  ERC20InsufficientAllowance: 'USDC allowance is too low — approve first.',
};

/** selector (0x12345678) → error name, computed from the ABIs. */
export const SELECTOR_TO_ERROR: Record<string, string> = Object.fromEntries(
  allErrorsAbi.filter((x): x is Extract<typeof x, { type: 'error' }> => x.type === 'error')
    .map((e) => [toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`).toLowerCase(), e.name]),
);

export function messageForErrorName(name: string): string {
  return ERROR_MESSAGES[name] ?? `The transaction would fail (${name}).`;
}

export function messageForRevertData(data: Hex | undefined): string | undefined {
  if (!data || data.length < 10) return undefined;
  const name = SELECTOR_TO_ERROR[data.slice(0, 10).toLowerCase()];
  return name ? messageForErrorName(name) : undefined;
}

const textOf = (e: unknown): string => {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const o = e as { shortMessage?: string; message?: string; details?: string };
  return [o.shortMessage, o.details, o.message].filter(Boolean).join(' | ');
};

function codeOf(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'number') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Find a hex revert payload anywhere in an error chain. */
function findRevertData(e: unknown): Hex | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 10 && cur; i++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d)) return d as Hex;
    if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') return (d as { data: Hex }).data;
    cur = (cur as { cause?: unknown }).cause;
  }
  const m = /(0x[0-9a-fA-F]{8})(?:[0-9a-fA-F]{64})*\b/.exec(textOf(e));
  return m && SELECTOR_TO_ERROR[m[1]!.toLowerCase()] ? (m[1] as Hex) : undefined;
}

/** Turn anything thrown by viem / a wallet / our own code into one human sentence. */
export function friendlyError(e: unknown): string {
  if (e == null) return 'Something went wrong.';
  const code = codeOf(e);
  const text = textOf(e);
  const low = text.toLowerCase();

  if (code === 4001 || /user (rejected|denied)|rejected the request|user cancel|request rejected|denied transaction/.test(low)) {
    return 'You cancelled in your wallet.';
  }
  if (code === 4100) return 'Your wallet has not authorised this site. Connect your wallet first.';
  if (code === 4902 || /unrecognized chain|chain .*not (been )?added/.test(low)) return 'Your wallet does not know this network yet. Add Base, then try again.';
  if (code === -32002 || /already pending/.test(low)) return 'Your wallet already has a request open — check the wallet window.';
  if (/does not match the target chain|chain mismatch|wrong (network|chain)|chainid.*mismatch/.test(low)) {
    return 'Your wallet is on the wrong network. Switch to Base and try again.';
  }

  // Contract custom errors (decoded by viem or raw selector)
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) {
      if (rev.data?.errorName && rev.data.errorName !== 'Error') return messageForErrorName(rev.data.errorName);
      const raw = (rev as unknown as { raw?: Hex }).raw;
      const byRaw = messageForRevertData(raw ?? rev.signature);
      if (byRaw) return byRaw;
      if (rev.reason) return reasonSentence(rev.reason);
    }
  }
  const byData = messageForRevertData(findRevertData(e));
  if (byData) return byData;

  if (/transfer amount exceeds balance/.test(low)) return 'Not enough USDC in your wallet.';
  if (/transfer amount exceeds allowance|insufficient allowance/.test(low)) return 'USDC allowance is too low — approve first.';
  if (/insufficient funds|exceeds balance|gas required exceeds|insufficient balance for transfer/.test(low)) {
    return 'Not enough ETH on Base to pay the network fee.';
  }
  if (/nonce too low|replacement transaction underpriced/.test(low)) return 'Your wallet has a stuck or conflicting transaction. Wait, then try again.';
  if (/failed to fetch|network ?error|timeout|timed out|http request failed|429|rate limit/.test(low)) {
    return 'The network request failed. Check your connection and try again.';
  }
  if (/no wallet|no provider|not connected|connector not/.test(low)) return 'No wallet connected. Connect a wallet first.';
  if (/reverted/.test(low)) return 'The transaction was reverted by the contract.';

  // Our own thrown Errors are already plain sentences.
  if (e instanceof Error && !(e instanceof BaseError) && e.message) return e.message;
  if (e instanceof BaseError && e.shortMessage) return e.shortMessage.split('\n')[0]!;
  return 'Something went wrong.';
}

function reasonSentence(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('exceeds balance')) return 'Not enough USDC in your wallet.';
  if (r.includes('allowance')) return 'USDC allowance is too low — approve first.';
  return `The contract refused: ${reason}.`;
}
