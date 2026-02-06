# Project plan

## Background

Goal: build a WalletGuard-like transaction simulation + risk report + plain-English explanation, executed via a Chainlink CRE workflow. The long-term direction includes gating via x402 pay-per-analysis and anchoring a commitment/receipt hash onchain.

## Current state

- `cre workflow simulate` succeeds for `cre-workflows/walletguard-analyze`.
- Workflow compilation uses `cre-compile-workflow` (repo-root shim) instead of the stock compiler.
- The shim runs `javy init-plugin` on the Chainlink Javy plugin WASM once and caches the initialized output, then uses it for `javy build`.
- Request fixtures exist under `cre-workflows/walletguard-analyze/fixtures/`.

### Why the shim exists

On macOS arm64 with Javy v5.x, the Chainlink Javy plugin compilation path can panic inside `javy-plugin-api` unless the plugin is initialized first. Initializing the plugin via `javy init-plugin` produces a plugin WASM that includes the necessary runtime initialization, which avoids the unwrap panic and allows compilation.

## TODO (next steps)

### Workflow correctness (high priority)

- [ ] Wire `@walletguard/walletguard-core` into `cre-workflows/walletguard-analyze/src/main.ts`.
  - Use `decodeTopLevelCall` + `assessRisk` + `buildWalletGuardReport` so fixtures produce non-stubbed risk output.
- [ ] Add a small local runner to simulate the workflow across all fixtures and print a compact summary (risk level/score/flags).

### Real simulation & richer signals (medium priority)

- [ ] Replace stub simulation with RPC-backed execution so `nativeBalanceDeltas`, `tokenBalanceDeltas`, and logs are real.
- [ ] Expand decoding beyond top-level calls (trace decoding, internal calls).
- [ ] Add contract metadata signals:
  - new contract detection
  - code verification checks
  - proxy/admin patterns

### Productization (medium priority)

- [ ] Add x402 pay-per-analysis gating.
- [ ] Add onchain commitment of report hash (ReportRegistry) and later generalized receipts (ReceiptRegistry).

## Notes

- Workflow simulation currently targets Sepolia RPC via `project.yaml`.
- The fixtures intentionally include common risky patterns:
  - ERC20 unlimited approval (`approve(spender, 2^256-1)`)
  - ERC721 `setApprovalForAll(operator, true)`
