# Outbid — agents bid against each other for work

*(Outbid is a working title.)*

## Intent

Show agent-to-agent commerce that is more than "agent A pays agent B". A person gives
their agent a task and a small budget. Several seller agents compete for it with
**signed, short-lived, binding invoices**; the buyer agent picks one, pays under an
on-chain spending policy, and the winner delivers only after it has verified the payment
on-chain. Every step shows up on a live ledger the person can watch and shut off.

Why this and not a directory/marketplace: Remesso already ships a wallet MCP server,
spending policies and an x402 client. What it does not give you is **price discovery
between agents** (agent profiles list accepted tokens, no prices) or a way to compare
sellers. Signed invoices are the Remesso primitive the official agent-to-agent guide never
uses, and they make a bid binding and verifiable before any money moves.

## One job, end to end

1. The person gives the buyer agent a task, a budget and a deadline.
2. The buyer broadcasts an RFQ (task, budget, deadline, the person's address as `payer`).
3. Each seller answers with a signed invoice — price, valid 120 s, bound to that payer —
   plus a promised delivery time.
4. The buyer verifies every invoice (`invoices.verify`, pays nothing), scores the bids,
   and picks a winner.
5. The buyer pays the winning invoice from the person's policy (`invoices.pay`, funding
   `policy`, `maxDebit` = the bid).
6. The winner verifies the payment on-chain (`invoices.verifyPayment`), claims it exactly
   once, runs the work, and delivers.
7. The buyer grades the result. Price, speed and grade feed each seller's track record,
   which the next auction uses.
8. Everything above is emitted as typed events and rendered on the ledger.

## Goals

- A real auction between real (LLM-backed) agents, settled by real Remesso payments.
- The person's limits are enforced by the contract, not by agent good behaviour:
  per-payment cap, daily cap, recipient allowlist, expiry, revoke.
- Every bid is binding and verifiable; every payment is claimed exactly once.
- Runs end to end on a local Celo fork for **zero real money**; the same code runs on
  mainnet by changing the RPC URL.
- A demo that is watchable in 60 seconds: live auction, price race, payment, delivery.

## Non-goals

- No escrow, disputes or refunds (Remesso has none; a seller can take the money and
  deliver junk). Mitigation is small jobs plus track records.
- No agent discovery registry (ERC-8004) in v1.
- No multi-token or cross-currency auctions. One token (USDT).
- No custody, no user accounts, no production multi-worker hosting.

## Anti-goals (a failure even if it technically works)

- Looking like a generic dashboard or a clone of another project's landing page.
- An auction that is staged: bids must come from real seller logic, not a scripted list.
- Spending real money without the person's explicit go-ahead.

## Ground truth from the SDK (read in `node_modules/remesso-sdk@0.3.1`)

- An invoice is an EIP-712 `Remesso Invoice` signed by the **recipient** (seller): issuer,
  payer, recipient, token, amount, orderId, nonce, issuedAt, expiresAt, requestId.
- `payer` is the **funds owner** (the person), even when a different policy agent key signs
  the payment. So every bid names the person's address, not the buyer agent's.
- An invoice with no backend request has `requestId: ""` and is tied to its payment by the
  memo `invoiceReference(id)`, so it must be paid from a **policy** — which is what we want.
- `invoices.pay` reserves the invoice to one signer/route (`InvoiceStore`); a different
  route is refused. `memoryInvoiceStore()` is process-local.
- `invoices.verifyPayment` accepts only that invoice's own payment. Docs: store the invoice
  id, the payment's `eventId` and the order **uniquely** when fulfilling.
- Policies: owner creates, agent key pays, one token, `perPayment` ≤ `perDay`, up to 50
  allowlisted recipients, revoke is permanent. Policy payments carry no fee and have no
  per-payment minimum. ~85k gas per payment; the agent needs CELO or pays gas in USDT.
- There is **no testnet**. `startDev()` (`remesso-sdk/dev`) starts an owned local anvil
  fork, a backend stand-in, and funded `buyer`/`seller`/`treasury` accounts. Anvil 1.5.1 is
  installed.
- Finality: `included` is immediate but reorg-able; `finalized` takes ~25–30 min.
- Not documented / unknown: whether an invoice can be left open to any payer.

## Decisions

**The person decided:** build the RFQ-auction idea; TypeScript is fine.

**My calls (change any of them):**

- **Stack:** TypeScript, Node 22, `remesso-sdk` + viem, vitest. Claude powers the agents'
  reasoning and the sellers' work. When `ANTHROPIC_API_KEY` is absent, a deterministic stub
  skill runs instead, so tests and the demo never need the key.
- **Dev target:** local fork by default (`startDev`). Mainnet only behind an explicit flag.
- **Transport:** in-process typed event bus first (agents are separate objects with their
  own keys). HTTP between agents is a later swap, not a v1 need.
- **Scoring:** transparent weighted score — price, promised speed, track record — shown on
  the ledger so a choice can be explained. No hidden model-based ranking.
- **Verification depth:** micro-jobs (≤ a few cents) deliver on `included`; the ledger shows
  "final" once Celo finalizes. Larger jobs wait for `finalized`.
- **Grading:** the buyer grades results with a cheap model call (stub: rule-based).
- **Sellers:** three to start — translate, summarize, extract — with different prices,
  speeds and quality.
- **Web UI:** a server-sent-events feed plus a single-page live ledger; its visual identity
  is decided separately and must not look templated.

## Architecture

```
src/
  chain/      fork.ts (startDev wrapper), accounts.ts (owner/buyer/sellers), fund.ts
  agents/     seller.ts  buyer.ts  scoring.ts  reputation.ts
  skills/     skill.ts (interface)  claude.ts  stub.ts
  arena/      round.ts (one auction)  events.ts (typed event bus)
  server/     feed.ts (SSE)  app.ts
web/          live ledger (built after the core is green)
test/         unit + fork integration
```

Events (the ledger contract): `rfq.opened`, `bid.received`, `bid.rejected`, `winner.chosen`,
`payment.sent`, `payment.included`, `payment.final`, `work.started`, `work.delivered`,
`result.graded`, `policy.revoked`.

## Build order

1. Scaffold, fork harness, funded accounts, one policy. Prove: a policy-funded invoice
   payment verifies on the fork.
2. Seller (bid + fulfil) and buyer (verify, score, pay) with stub skills; a full round in a
   vitest fork test.
3. Exactly-once claiming, expiry, over-cap and revoked-policy failure paths.
4. Claude-backed skills and grading.
5. Event bus, SSE feed, live ledger UI.
6. **Spike, then decide:** subcontracting (winner buys part of the job from another seller
   from a policy of its own). Ships only if the spike works.
7. Mainnet dry run with cent-sized jobs — only after the person funds the wallets.

## Open items for the person

- An `ANTHROPIC_API_KEY` for the real agent run (not needed to build).
- A small USDT + CELO budget for the final mainnet run (not needed to build).
- Whether the ledger UI wants a specific look; otherwise I propose one with a mockup first.

## Findings during the build

- **Bid life must exceed 60 s.** `remesso-sdk` refuses to start a payment whose deadline is
  within `START_MARGIN_S = 60` s, and policy payments are not broadcast in the last 30 s.
  Bids therefore live 120 s, which gives the buyer a 60 s window after a bid is signed.
- **One arena per process.** `remesso-sdk` keeps signer state (nonces, pending sends) for the
  life of the process; a second fork's first transaction hangs. `startArena` refuses a second
  call; tests that need another fork run in their own file.
- **Dear jobs wait, they do not fail.** A payment above 0.10 USDT needs `finalized` (~25-30 min on
  Celo). The seller verifies at `included` first, then waits; the round stays open meanwhile.
  On the fork, 64 newer blocks finalize a payment (`ArenaEnv.mine`).
- **Never pay a second bid after an uncertain send.** Only `refused`, `reverted` and `no_gas`
  mean no money moved; a pending payment or any other failure aborts the round.
- **Subcontracting works (spike passed, `test/spike/subcontract.test.ts`).** Any wallet can own a
  policy, so a paid seller can create one naming a worker key, allowlisting a sub-seller; the
  worker pays the sub-seller's invoice (`payer` = the seller) and the sub-seller verifies it.
  The worker key needs gas (CELO). On the fork the seller needs CELO too, because plain anvil does
  not support Celo's pay-gas-in-USDT extension (real Celo does). Adding it to `runRound`/`Seller`
  is a follow-up plan, not part of this one.

