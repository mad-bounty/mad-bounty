# Docs validation receipt

Generated 2026-11-25T12:00:42Z against `src/MADBountyCore.sol` @ 1bb4994 (sha256 3424f341da728e9b…).

## 1. JSON parse (python3 -m json.tool) + schema validation (jsonschema Draft 2020-12)
```
OK  schemas/bounty-spec.schema.json
OK  examples/account-handoff-enckey.json
OK  examples/agent-data-onchaincheck.json
OK  examples/storefront-photo-teeml.json
OK  agent-card.json
OK  schema is valid Draft 2020-12
OK  examples/account-handoff-enckey.json validates against schema
OK  examples/agent-data-onchaincheck.json validates against schema
OK  examples/storefront-photo-teeml.json validates against schema
```

## 2. Names referenced in docs vs. code (regex: every `name(` in docs/*.md|txt|json)
```
Defined in MADBountyCore.sol: ['BURN', 'CLAIM_TYPEHASH', 'COOLING', 'FEE_BPS', 'MAX_OPEN', 'MAX_REVIEW', 'MAX_REWARD', 'MAX_WORK', 'MIN_DEPOSIT', 'MIN_DEPOSIT_BPS', 'MIN_REVIEW', 'MIN_REWARD', 'MIN_WORK', 'NAME', 'REVERSE_TYPEHASH', 'TERMS', 'VERDICT_TYPEHASH', 'VERSION', '_accept', '_pay', '_pull', '_reverse', '_settle', 'balanceOf', 'bounties', 'cancel', 'claim', 'core', 'domainSeparator', 'extendReview', 'finalizeReject', 'manualHash', 'manualURI', 'minDeposit', 'nextId', 'owed', 'payOnTimeout', 'post', 'reclaimAbandoned', 'refundExpired', 'reverse', 'reverseWithSig', 'send', 'settle', 'settleWithSig', 'submit', 'token', 'transfer', 'transferFrom', 'treasury', 'usdc', 'vaultImpl', 'withdraw']
Events: ['Abandoned', 'Burned', 'Cancelled', 'Claimed', 'Expired', 'Owed', 'Paid', 'Posted', 'Refunded', 'Rejected', 'Reversed', 'ReviewExtended', 'Submitted', 'Withdrawn']
Errors: ['BadParam', 'BadSig', 'BadState', 'NotAllowed', 'TooEarly', 'TooLate', 'TransferFailed']
Call-style names referenced in docs (non-external): ['CLAIM_TYPEHASH', 'NAME', 'REVERSE_TYPEHASH', 'SHA256', 'TERMS', 'VERDICT_TYPEHASH', 'VERSION', 'bounties', 'cancel', 'claim', 'domainSeparator', 'extendReview', 'finalizeReject', 'manualHash', 'manualURI', 'minDeposit', 'name', 'nextId', 'owed', 'payOnTimeout', 'post', 'reclaimAbandoned', 'refundExpired', 'reverse', 'reverseWithSig', 'settle', 'settleWithSig', 'submit', 'treasury', 'usdc', 'vaultImpl', 'withdraw']
UNKNOWN (referenced but not in core): [('SHA256', 'docs/MANUAL.md'), ('SHA256', 'docs/WORKER.md'), ('SHA256', 'docs/llms-full.txt'), ('name', 'docs/RECEIPT.md')]
  Abandoned: documented
  BadParam: documented
  BadSig: documented
  BadState: documented
  Burned: documented
  Cancelled: documented
  Claimed: documented
  Expired: documented
  NotAllowed: documented
  Owed: documented
  Paid: documented
  Posted: documented
  Refunded: documented
  Rejected: documented
  Reversed: documented
  ReviewExtended: documented
  Submitted: documented
  TooEarly: documented
  TooLate: documented
  TransferFailed: documented
  Withdrawn: documented
```
Note: `name` is this receipt's own description text. `SHA256` is from `HKDF-SHA256(...)` (crypto primitive), not a contract function. Periphery adapter names (FallbackVerifier etc.) are not core functions and are deferred to periphery/README.md.

## 3. Function selectors (forge inspect methodIdentifiers) vs. cast signatures used in docs
```
OK  0xb53ff0ff post((address,address,uint96,uint96,uint32,uint32,uint64,uint8,bytes32,bytes))
OK  0x5eddd157 claim(uint256,uint256,bytes)
OK  0x2ecea788 submit(uint256,bytes32)
OK  0xfe417a47 settle(uint256,bool)
OK  0x13b5faf7 settleWithSig(uint256,bool,bytes)
OK  0x1c76ecc9 reverseWithSig(uint256,bytes)
OK  0x5a73bacd payOnTimeout(uint256)
OK  0x074af4ca finalizeReject(uint256)
OK  0x79ffa8ce reclaimAbandoned(uint256)
OK  0x1402b17a refundExpired(uint256)
OK  0x2e1a7d4d withdraw(uint256)
OK  0x1755ccfc owed(uint256,address)
OK  0x40dc8aa8 minDeposit(uint256)
```

## 4. EIP-712 typehashes (cast keccak of the exact strings in the contract)
```
OK  0xb16ae7c48c54094b3ebe233d2729bc2c3e12d15a49ea8e7c52cc07ef9dfd1623 Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept) (matches llms-full.txt)
OK  0x7992345e323822f733c9d4fb722ac259ce6647a13a2adfad0d27e980366d910b Reverse(uint256 id,address worker,bytes32 evidenceHash) (matches llms-full.txt)
OK  0xc7a08884b29d7fa74e1deb5191f125619a614b58540a1bba51b95f631d19311f Claim(uint256 id,address worker,uint256 deadline) (matches llms-full.txt)
```

## 5. llms.txt length
47 lines (limit 120)

## 6. Extra getters not listed above
OZ `EIP712` also exposes `eip712Domain()` (ERC-5267), which returns the same domain fields.
