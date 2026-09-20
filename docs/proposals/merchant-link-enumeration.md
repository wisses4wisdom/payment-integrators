# Merchant Link Enumeration — Proposal

**What:** give the frontend a way to fetch "all payment links owned by
merchant X" without scanning event logs.
**Why:** the current approach (payqr's `/payment-links` page) log-scans
`LinkCreated` events backward from the chain tip. On an RPC with a narrow
`eth_getLogs` range cap (seen in practice: an Alchemy free-tier key limits it
to **10 blocks per call**), a realistic lookback window needs thousands of
sequential requests, which the browser itself refuses to make
(`ERR_INSUFFICIENT_RESOURCES`). This is a hard capability gap, not a config
tweak — it needs a contract change.
**Status:** proposal, not yet built. No frontend or worker change should
land against this until the interface below is agreed and deployed.

---

## The constraint that shapes every option here

`MerchantTerminalIntegrator.sol` sits at the EIP-170 24,576-byte ceiling.
`PaymentLinksLib` exists ONLY because the link feature didn't fit inline
(measured 24,714 bytes at `runs: 1`, over budget at every optimizer
setting). See that library's own header comment. **Any enumeration feature
must be sized and reviewed with this in mind** — it is not a "just add a
getter" change, and the cheapest-sounding option (an array push) is also the
one most likely to blow the size budget once tests + a getter are added.

---

## Current storage (for context)

```solidity
// MerchantTerminalIntegrator.sol
mapping(bytes32 => PaymentLinksLib.PaymentLink) internal links;
```

A plain hash map. There is no per-owner index today — `getLink(linkId)`
answers "tell me about this one link", never "list this merchant's links".
`LinkCreated(linkId indexed, owner indexed, ...)` is emitted on creation, but
log-scanning is the only current way to turn `owner` back into a set of
`linkId`s.

---

## Option A — on-chain index: `mapping(address => bytes32[])`

Add to `PaymentLinksLib.create()`:

```solidity
mapping(address => bytes32[]) storage ownerLinks; // new param
...
ownerLinks[msg.sender].push(linkId);
```

Plus a view, ideally paginated (an active merchant could accumulate
hundreds of links over time and an unbounded return grows unbounded gas/
calldata on read):

```solidity
function getMerchantLinks(address owner, uint256 offset, uint256 limit)
    external view returns (bytes32[] memory);
```

**Trade-offs**

- Real, permanent storage growth: one `SSTORE` per link created, forever un-prunable
  (revoking a link doesn't shrink the array — nothing here should try to,
  since reordering/removing from the array would desync any offset a caller
  cached between calls).
- Extra gas on every `createLink` call, paid by the merchant.
- New bytecode in `PaymentLinksLib` (a new mapping param threaded through
  `create`, plus the paginated getter) — needs a real size measurement
  against the ceiling before this is treated as "just add it." If it doesn't
  fit, something inline has to move out to make room, which is its own
  scoped task.
- Correctness is simple and it's trustlessly readable in one `eth_call` —
  no indexer dependency, no lag.

**This is the recommended option** if the size budget allows it, because it
requires no new infrastructure and matches how `orderToLink` already indexes
by a different key.

---

## Option B — subgraph: index `LinkCreated` in the existing p2p.me subgraph

The frontend already depends on a subgraph (`SUBGRAPH_URL` in payqr's
`lib/p2p.ts`) for transaction history (`b2Borders`, `orders_collection`).
Confirmed by direct query: that subgraph's schema has **no `LinkCreated`
entity today** — this is not "flip a flag," it's a subgraph mapping change
and redeploy by whoever owns that indexer.

**Trade-offs**

- Zero contract bytecode cost, zero extra merchant gas.
- Indexing lag (typically seconds, but it's an eventually-consistent read,
  not a trustless one — for a merchant's own "here are my links" list this
  is an acceptable trade, unlike anything involving fund movement).
- Depends on a separate team/service owning that subgraph; not something
  this repo can ship unilaterally.
- Doesn't help anyone reading the contract directly (SDKs, other
  integrators) — only payqr's frontend benefits.

---

## Option C — do nothing on-chain; bound the frontend scan instead

Cap the log-scan lookback window tightly (e.g. ~2,000 blocks, roughly the
last hour on Base Sepolia's ~2s block time) so it stays under a few hundred
requests even on a 10-block-per-call RPC. No contract or subgraph change.

**Trade-offs**

- Ships instantly, zero contract risk.
- Fundamentally incomplete: a merchant's older links silently stop
  appearing in their own list. Fine for active testnet iteration, wrong for
  production once a merchant has been live more than the window covers.
- Should be treated as a stopgap, not a resolution — it doesn't answer the
  underlying question ("what are all of this merchant's links") at all, it
  just narrows the failure until it's rare enough to not notice.

---

## Recommendation

Ship **Option A** if a size measurement confirms it fits (or can be made to
fit by moving something else out of the integrator, as `PaymentLinksLib`
itself already did once). Treat **Option C** as the interim frontend
mitigation while A is built — payqr should shrink its lookback window now
rather than ship the current unbounded scan, which is provably broken on at
least one real RPC tier.

Option B is worth raising with whoever owns the subgraph as a
longer-horizon parallel improvement, but shouldn't block A: it solves this
one frontend's read path, not the general "list a merchant's links from the
contract" capability other integrators/SDKs may also want.

## Open questions for the contract dev

1. Does `getMerchantLinks` fit in `PaymentLinksLib` alongside the existing
   four entry points, or does something else need to move out of the
   integrator first? (Needs an actual `forge build --sizes` / hardhat size
   check, not a guess.)
2. Pagination shape: `(offset, limit)` index-based, as sketched above, or a
   cursor keyed off the last returned `linkId`? Index-based is simpler but
   returns confusing results if links are ever removed from the middle of
   the array in the future (they currently aren't — `revoke` only flips a
   status flag, never removes from any array) — worth deciding explicitly
   rather than by accident.
3. Should `getMerchantLinks` return full `PaymentLink` structs (saves the
   frontend a second round of `getLink` calls per id) or just the
   `bytes32[]` of ids (smaller/cheaper, matches how `getLink` is already the
   single read API for one link)? Given `getLink`'s own doc comment
   explicitly avoids an auto-generated struct getter to save bytecode, ids-only
   is likely the more consistent choice.
