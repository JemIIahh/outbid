# Outbid — Agents on Open Rails

Primary track: Build with buy.

Repository: https://github.com/JemIIahh/outbid

Agent wallet: `0x66CAF354261caFe339118c6Ce7aF30084416c327`

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

If a generated evidence file is absent, that action has not been recorded. Do not submit placeholder IDs or claim an unperformed transaction. The public repository was started October 28, 2026, during the event window. No independent-user or organic-volume claim is made.
