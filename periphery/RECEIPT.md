# Periphery test receipt

Command: `FOUNDRY_TEST=periphery/test forge test --match-path 'periphery/test/*'` (solc 0.8.34, via_ir, OZ v5.1.0)

```
Suite result: ok. 6 passed; 0 failed; 0 skipped; finished in 7.12ms (4.62ms CPU time)
Suite result: ok. 6 passed; 0 failed; 0 skipped; finished in 14.66ms (14.46ms CPU time)
Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 25.62ms (20.40ms CPU time)
Suite result: ok. 12 passed; 0 failed; 0 skipped; finished in 86.42ms (39.39ms CPU time)
Suite result: ok. 16 passed; 0 failed; 0 skipped; finished in 672.25ms (928.64ms CPU time)
Ran 5 test suites in 673.72ms (806.07ms CPU time): 48 tests passed, 0 failed, 0 skipped (48 total tests)
```

Note: plain `forge test --match-path 'periphery/test/*'` reports "No tests found" because foundry.toml's test dir
defaults to `test/`; `FOUNDRY_TEST=periphery/test` (env override, no config edit) makes forge compile periphery tests.

Includes the real 0G TeeML signature vector (recovers 0x878d588e92abede728fe6e76dd46c4d7d1626c96) and BytesSearch fuzz (256 runs x2).
