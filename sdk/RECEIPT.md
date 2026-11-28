# SDK receipt — @madbounty/sdk 0.1.0

Date: 2026-11-25 (UTC 12:06). Node v22, viem 2.58.6, vitest 3.2.7, anvil (Foundry).
Contracts: real `MADBountyCore` + `MockUSDC` bytecode from `forge build` (`out/`), deployed fresh on anvil (random port) per test file.
Command: `cd sdk && npm test` (tsc build + vitest). Exit 0.

## Verbose results
```
✓ test/unit.test.ts > spec hashing > is key-order and whitespace independent 15ms
 ✓ test/unit.test.ts > spec hashing > rejects non-JSON values 2ms
 ✓ test/unit.test.ts > encryption > roundtrips and rejects wrong key / tamper 115ms
 ✓ test/unit.test.ts > math > mirrors contract rules 2ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > post -> claim -> submit -> settleWithSig(accept) pays worker and treasury 237ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > signature for wrong accept value is rejected (BadSig) 161ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > reject -> 24h cooling -> finalizeReject burns reward + deposit (Burn mode) 212ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > reject then reverseWithSig pays the worker 163ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > Refund mode reject returns reward to agent and burns deposit 161ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > verifier silence -> payOnTimeout pays worker; keeperSweep finds and executes it 174ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > direct payOnTimeout and reclaimAbandoned / refundExpired via findTimeouts 347ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > claimAuthorizer: claim requires a signed Claim 122ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > safety checker flags dangerous bounties 166ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > encKey on-chain roundtrip: worker encrypts to posted key, agent decrypts 148ms
 ✓ test/lifecycle.test.ts > lifecycle on anvil > unsigned tx builders encode the same calldata the contract accepts 55ms
 Test Files  2 passed (2)
      Tests  15 passed (15)
```

## npm test tail
```
 ✓ test/unit.test.ts (4 tests) 151ms
 ✓ test/lifecycle.test.ts (11 tests) 2384ms
   ✓ lifecycle on anvil > direct payOnTimeout and reclaimAbandoned / refundExpired via findTimeouts  343ms

 Test Files  2 passed (2)
      Tests  15 passed (15)
   Start at  20:05:31
   Duration  4.34s (transform 420ms, setup 0ms, collect 2.24s, tests 2.53s, environment 1ms, prepare 308ms)
```

Covered: accept via settleWithSig (balances: worker +P-1%+D, treasury +1%, vault 0), BadSig on mismatched verdict, Burn-mode reject + 24h time travel + finalizeReject (0xdEaD +P+D), reverseWithSig, Refund-mode reject, payOnTimeout via keeperSweep, reclaimAbandoned/refundExpired via findTimeouts, claimAuthorizer EIP-712 Claim (TooLate / BadSig / success), safety checker (REFUND_SELF_VERIFIED, REFUND_UNKNOWN_VERIFIER, HIGH_DEPOSIT, SHORT_WORK_WINDOW, NOT_FOUND), on-chain encKey + x25519/XChaCha20 roundtrip, unsigned tx builders.
Not covered: real Base USDC (fork), ERC-1271 verifiers, `owed`/withdraw after a failed push (MockUSDC blacklist exists but untested here).
