# audit/fuzz: stateful fuzz + symbolic campaign vs src/MADBountyCore.sol

Target sha256 (src/MADBountyCore.sol == msrc/ copy): a6f1ae677ffdc5406935219b09c8270734738368aa91ea18c3586db3f1de430b

## Layout
- harness/MADFuzzHandler.sol: one stateful handler shared by Foundry, medusa, echidna. Every core call goes through
  `_exec`, which snapshots all balances and owed entries, runs the call as the chosen actor, then checks the exact
  per-function transition and money delta. Any mismatch latches `violated` with a reason.
  Actors: 2 agents, 2 workers, griefer, 2 verifier EOAs (ECDSA sigs), treasury, BURN. USDC mock can be paused,
  blacklist any actor or any bounty vault. Griefer replays every verifier signature ever made, calls privileged
  functions, calls vaults directly, and calls permissionless exits with chosen gas limits (63/64 griefing).
- mharness/ + msrc/: the same harness importing a byte-identical copy of the core (crytic-compile can't reach ../../src).
- test/FuzzInvariant.t.sol: Foundry invariants (5 split + `invariant_all`).
- test/HalmosFee.t.sol: halmos `check_*` + forge fuzz mirrors.
- test/GasGriefScan.t.sol: deterministic gas-limit sweep for owed-diversion on every permissionless exit.
- mut/: 3 mutants of the core, used to show the harness catches real bugs (all caught).

## Run
    export PATH=$HOME/.foundry/bin:$PATH; cd ~/projects/mad-bounty
    FOUNDRY_TEST=audit/fuzz/test forge test --match-path 'audit/fuzz/test/*'
    cd audit/fuzz && PATH=$HOME/.local/share/uv/tools/slither-analyzer/bin:$PATH ~/.local/bin/medusa fuzz --config medusa.json
    cd audit/fuzz && ~/.local/bin/echidna mharness/MADFuzzHandler.sol --contract MADFuzzHandler --config echidna.yaml
    HALMOS_ALLOW_DOWNLOAD=1 FOUNDRY_TEST=audit/fuzz/test audit/fuzz/.venv/bin/halmos --contract HalmosFeeTest --solver bitwuzla
    # mutants:
    FOUNDRY_OUT=audit/fuzz/out-mut FOUNDRY_TEST=audit/fuzz/mut forge test --match-test invariant_all

Logs: logs/. See RESULTS.md.
