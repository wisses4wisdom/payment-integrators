# payment-integrators — Merchant Terminal

Solidity integrator for the **P2P B2B checkout protocol**: a merchant payment
terminal that accepts local fiat (UPI, PIX, SPEI, …) and settles in USDC on Base.

The **MerchantTerminalIntegrator** sits between the merchant-facing frontend and
the P2P Diamond. It custodies merchant USDC internally (v13 internal-custody
design — no external vault), enforces per-transaction caps and daily limits,
manages settlement-locked balance buckets, and drives fiat withdrawals (SELL
orders) end-to-end including every failure-recovery path.

Solvency invariant: `usdc.balanceOf(integrator) >= totalOwed` — checked by the
test suite after every state-mutating flow.

## Repository layout

```
contracts/
├── interfaces/          Protocol surface (IOrderFlow, IP2PIntegrator, …)
├── base/UserProxy.sol   Canonical per-merchant CREATE2 proxy
├── integrators/
│   └── merchant-terminal/MerchantTerminalIntegrator.sol   The integrator
├── examples/            SimpleERC721Client (price source / reference client)
└── test/                Mocks for hardhat tests (MockDiamond, MockUSDC)

test/                    Hardhat tests (MerchantTerminalIntegrator.ts)
scripts/                 Deploy + admin + inspect helpers
docs/                    Architecture, proxy pattern, limits, whitelisting
deployment-record.json   Deployed addresses (Base Sepolia) + build history
```

## Quick start

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Key flows

- **Deposit (BUY):** end-user pays fiat → Diamond delivers USDC to the merchant's
  `UserProxy` → `onOrderComplete` credits the merchant under a settlement lock.
- **Withdraw to fiat (SELL):** `withdrawFiat` escrows principal on the proxy and
  places a SELL; `deliverFiatPayout` tops up the offramp fee and hands the
  payout payload to the Diamond; `finalizeWithdrawal` / `reconcileWithdrawal`
  settle the clean and cancelled outcomes. Every recovery path sweeps **only its
  own capped amount** off the shared proxy (sweep == credit, always).
- **Withdraw to wallet:** `withdrawUSDC` pays unlocked balance straight out.

## Deployment

See [`deployment-record.json`](deployment-record.json) for the current Base
Sepolia addresses and the full build history. Deploy with
[`scripts/deploy-merchant-terminal.ts`](scripts/deploy-merchant-terminal.ts);
admin helpers (`grant-admin`, `list-admins`, `transfer-superadmin`,
`set-product-price`) take their target addresses from env vars — nothing is
hardcoded.

> Whitelisting: the Diamond holds an explicit allowlist gating which integrators
> can place B2B orders. See [`docs/WHITELISTING.md`](docs/WHITELISTING.md).

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how an integrator fits the protocol
- [`docs/PROXY-PATTERN.md`](docs/PROXY-PATTERN.md) — the per-user CREATE2 proxy
- [`docs/LIMITS-AND-RP.md`](docs/LIMITS-AND-RP.md) — caps, daily limits, risk params
- [`docs/integrators/merchant-terminal.md`](docs/integrators/merchant-terminal.md) — this integrator

## License

[Apache 2.0](LICENSE).
