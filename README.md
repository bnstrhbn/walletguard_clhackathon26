# WalletGuard (Chainlink Convergence Hackathon 2026)

This repository is a work-in-progress prototype for a WalletGuard-like transaction analysis flow executed via a Chainlink CRE workflow.

## What works right now

- A local CRE workflow simulation for `cre-workflows/walletguard-analyze`.
- A `cre-compile-workflow` shim that compiles the workflow JS->WASM using the Chainlink Javy plugin, including a plugin initialization step (`javy init-plugin`) to avoid the known plugin panic on macOS arm64.
- A small set of JSON request fixtures you can use as `--http-payload` inputs.

## Quickstart (local workflow simulation)

From repo root:

```bash
cre -T staging-settings workflow simulate ./cre-workflows/walletguard-analyze \
  --non-interactive \
  --trigger-index 0 \
  --http-payload ./cre-workflows/walletguard-analyze/fixtures/solodit-02-erc20-approve-unlimited.json
```

If you need a minimal payload, see `cre-workflows/walletguard-analyze/fixtures/`.

## Repo docs

- `PROJECT_PLAN.md`: Background, current state, and next-step TODOs.
