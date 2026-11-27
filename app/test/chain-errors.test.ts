import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, toFunctionSelector, UserRejectedRequestError } from 'viem';
import { madBountyCoreAbi } from '@madbounty/sdk';
import { allErrorsAbi, ERROR_MESSAGES, friendlyError, messageForRevertData, SELECTOR_TO_ERROR } from '../src/chain/errors';

test('every core + adapter custom error has a selector and a message', () => {
  const coreErrors = (madBountyCoreAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === 'error').map((x) => x.name!);
  for (const n of [...coreErrors, 'CheckFailed', 'CheckPasses', 'LowGas', 'WrongAnswer', 'NotWorker', 'NotConfigured', 'BelowThreshold', 'NoVerdict', 'BadIndex']) {
    assert.ok(ERROR_MESSAGES[n], `message for ${n}`);
    assert.ok(Object.values(SELECTOR_TO_ERROR).includes(n), `selector for ${n}`);
  }
  assert.equal(SELECTOR_TO_ERROR[toFunctionSelector('TooEarly()')], 'TooEarly');
  assert.equal(SELECTOR_TO_ERROR[toFunctionSelector('BadState()')], 'BadState');
});

test('raw revert data maps to sentence', () => {
  assert.equal(messageForRevertData(toFunctionSelector('TooEarly()')), 'Too early: this becomes available later.');
  assert.match(messageForRevertData(toFunctionSelector('BadState()'))!, /not in the right state/);
});

test('viem ContractFunctionRevertedError decoded', () => {
  const data = encodeErrorResult({ abi: allErrorsAbi, errorName: 'WrongAnswer' });
  const err = new ContractFunctionRevertedError({ abi: allErrorsAbi, data, functionName: 'reveal' });
  const wrapped = new BaseError('call failed', { cause: err });
  assert.equal(friendlyError(wrapped), ERROR_MESSAGES.WrongAnswer);
});

test('nested RPC error with data field', () => {
  const e = { message: 'execution reverted', cause: { code: 3, data: toFunctionSelector('TooLate()') } };
  assert.match(friendlyError(e), /Too late/);
});

test('wallet errors', () => {
  assert.equal(friendlyError({ code: 4001, message: 'User rejected the request.' }), 'You cancelled in your wallet.');
  assert.equal(friendlyError(new UserRejectedRequestError(new Error('x'))), 'You cancelled in your wallet.');
  assert.match(friendlyError(new Error('insufficient funds for gas * price + value')), /ETH/);
  assert.match(friendlyError(new Error('ERC20: transfer amount exceeds balance')), /USDC/);
  assert.match(friendlyError(new Error('The current chain of the wallet (id: 1) does not match the target chain')), /wrong network/);
  assert.equal(friendlyError(new Error('Spec is too long.')), 'Spec is too long.');
  assert.equal(friendlyError(undefined), 'Something went wrong.');
});
