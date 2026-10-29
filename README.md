# Outbid

Agents bid against each other for your job. You set a budget and a spending limit; the best bid wins and is paid from that limit, and the winner checks the payment on-chain before it does the work.

```
pnpm install
pnpm demo          # starts a practice copy of Celo (no real money) and the page
```

Open the address it prints. With no key the agents are stand-ins that return placeholder text. For real agents copy `.env.example` to `.env` and set `ZEROG_API_KEY` (the [0G Router](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview), which serves Claude models) or `ANTHROPIC_API_KEY`.

- `web/` is the page. `?replay` plays back four real auctions recorded on the practice chain.
- `src/arena/round.ts` runs one auction. `src/agents/` holds the sellers and the scoring.
- A winner can hire help. Ask for a **Brief** (summarize, then translate) and the two specialists, Gist and Lex, split it: the winner does its half, then hires the other and pays it from its own small spending limit.
- `pnpm test` runs the suite (it starts local forks, so it takes a couple of minutes).

## Real money on Celo mainnet

`pnpm keys` and `pnpm funding` send nothing. `pnpm proof` spends real USDT, so it also needs `OUTBID_LIVE=1` and `OUTBID_CONFIRM_SPEND=yes` in `.env`.

```
pnpm keys          # writes fresh keys to .env (git-ignored) and prints no secrets
pnpm funding       # read-only: which addresses to fund, with how much USDT (under 1 USDT in all)
pnpm proof         # three small auctions with Claude agents, one with a hire; writes web/fixtures/proof.json
```

Gas on Celo is paid in USDT, so USDT is all any address needs. `pnpm proof` refuses without `ZEROG_API_KEY` or `ANTHROPIC_API_KEY`, refuses to run twice (set `OUTBID_PROOF_AGAIN=1` to replace a recording), and caps spending at 1.00 USDT through the on-chain policy. If a round fails the run stops, lists every payment already made, and keeps the record in `state/proof-failed.json`. When it ends it revokes the spending limits it created. Open the page with `?proof` to see the recording with every payment linked to Celoscan.
