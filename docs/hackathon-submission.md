# Outbid — Agents on Open Rails

Primary track: Build with buy.

Repository: https://github.com/JemIIahh/outbid

Agent wallet: `0x66CAF354261caFe339118c6Ce7aF30084416c327`

Live demo: https://outbid-silk.vercel.app

Assigned Loops attribution tag: `celo_11ffb74cf1fb`

## Description

Outbid lets a buyer agent ask specialist agents for signed bids, compare price, speed and reputation, and pay the winner using a capped USDT spending policy on Celo. The seller verifies the actual onchain payment before delivering. A winning specialist can hire and pay another specialist for the part of a job it cannot perform itself.

The intended user is a small business operator who needs customer feedback summarized, messages translated, or facts extracted and wants a clear spending ceiling. The interface exposes the auction, payment and delivery steps so the operator can see what happened.

## buy integration

Cencori inference, purchased through `https://gateway.usebuy.ai/cencori/v1/chat/completions`, powers the existing seller skills through the shared `Chat` interface. The integration discovers the live catalog, quotes the exact request, caps each payment at 0.01 USDT and records the full paid response and settlement transaction. It uses `@celo/buy-core` with no upstream API key and no automatic paid retries. Payment goes to a third-party service Outbid does not control.

`pnpm buy:proof --execute` demonstrates the seller summarizing customer feedback through that same skill implementation. It is a developer-run demonstration, not evidence of independent customer adoption or a complete mainnet auction. The full auction replay in `web/fixtures/round.json` was recorded on a local fork.

## Evidence to attach before submitting

- ERC-8004 ID and registration transaction from `web/fixtures/agent-registration.json`.
- Paid Cencori settlement transaction, payer, recipient, amount and actual output from `web/fixtures/buy-proof.json`.
- A demo of the auction UI (`pnpm demo`, or the recorded `?replay` view).
- The actual hackathon attribution code assigned to this entry.

## Recorded Celo mainnet evidence

- ERC-8004 agent **10065**, registered from the buyer wallet: [registration transaction](https://celoscan.io/tx/0x24e0183be0167d25540c07f498b4da35d585f42a1879484e3d90968c0bc40e05). Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. Both `ownerOf(10065)` and `getAgentWallet(10065)` were checked against the buyer wallet.
- Cencori inference purchased through buy for **0.01 USDC**: [settlement transaction](https://celoscan.io/tx/0x546da1fedd30ade8578b9f7a2966310ea4307b6755e0ce524d5cb876b2062374). The proof runner verified transaction success and the USDC `Transfer` event's sender, recipient and amount on Celo mainnet.
- Service recipient: `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`.
- The Loops-assigned attribution tag was added in a later [identity metadata transaction](https://celoscan.io/tx/0x69794450349f29c41f51c32a0b9360141774e075aef021ab17e12915b21c8b76). Its calldata was decoded and verified to include `celo_11ffb74cf1fb`. This does not retroactively tag the earlier registration or the x402 settlement. See [attribution evidence](../web/fixtures/attribution-proof.json).
- Registration recorded at `2026-11-09T09:11:17.075Z`; paid task recorded at `2026-11-09T09:11:41.529Z`. These are the actual execution times. The live Loops event API reports an extended submission deadline of `2026-11-09T12:30:00.000Z`.
- Evidence files: [registration](../web/fixtures/agent-registration.json) and [paid inference](../web/fixtures/buy-proof.json). The complete quote and service response are preserved, without private keys or signed payment authorizations.
- Balance reduction for registration plus the paid call, before the later attribution update: **0.019072 USDC**; buyer balance at that point: **0.080928 USDC**.

If a generated evidence file is absent, that action has not been recorded. Do not submit placeholder IDs or claim an unperformed transaction. The public repository was started October 28, 2026, during the event window. No independent-user or organic-volume claim is made.
