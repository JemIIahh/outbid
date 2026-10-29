# Outbid: live run, agents hiring agents, mainnet proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps are TDD: failing test first, watch it fail, minimal code, full suite green.

**Goal:** Take Outbid from "a recording of real rounds" to (A) a live auction anyone can run from the page, (B) winners that hire other agents and pay them, and (C) a verifiable real-money run on Celo mainnet — in that order.

**Architecture:** Same event bus and `runRound`. (A) is wiring and verification. (B) adds a `digest` job kind (summarize, then translate) and lets a specialist seller that wins it do its own half and hire a partner for the other half, paying the partner from its own wallet (`funding: "wallet"`), reported as `hire.*` events. (C) adds a mainnet env behind the existing `preflight`, a funding checker, a proof runner and a proof view.

**Tech Stack:** unchanged (TypeScript strict ESM, remesso-sdk 0.3.1, vitest 5, tsx, esbuild, @anthropic-ai/sdk).

**Spec:** `docs/superpowers/specs/2026-10-28-outbid-design.md`. Prior plan: `2026-10-28-outbid.md` (Tasks 1–12 done).

## Global Constraints

- Bid TTL 120 s. Jobs and sub-jobs ≤ 0.10 USDT deliver on `included`. Policy perPayment 0.50, perDay 5.00, days 1, budget 5.
- One `startArena` per process. Tests needing another fork live in their own file.
- Only `refused`, `reverted`, `no_gas` allow moving on after a failed payment; anything else aborts. This holds for hires too.
- NEVER spend real money or fund keys on a real network without the owner's explicit go-ahead. Mainnet needs `OUTBID_LIVE=1`, `OUTBID_CONFIRM_SPEND=yes`, non-public keys, chain 42220.
- Keys live only in `.env` (git-ignored). No Claude attribution in commits. Commit only when asked.
- Exact-PID process kills only. Verify no stray anvil after every run.

## Review Focus

- A hire whose partner refuses, times out or reverts after the buyer already paid the winner: the round must end `aborted` with the reason, never hang, never pay twice.
- A partner that returns a bad invoice (wrong payer, wrong recipient, over cap, tampered): the hirer must refuse to pay it.
- The same partner payment must not fulfil twice (claim store), and the partner's own work events must not look like the winner's delivery.
- Revoking the buyer's policy while a hire is in flight: the hire was paid from the seller's own wallet, so it completes; no new buyer payment starts.
- Live page: double-clicking Start, revoking mid-round, fast-forward before a payment is included, and a server that restarts (page falls back cleanly).

---

### Task 13: Env file, `.env.example`, demo script

**Files:** Modify `package.json`, `.gitignore`. Create `.env.example`, `README.md`.

- [ ] `demo` runs `tsx --env-file-if-exists=.env src/main.ts`; `.env.example` lists `ANTHROPIC_API_KEY`, `PORT`, `OUTBID_ADVERSARY` (and the mainnet vars, commented, with a warning). `.gitignore` keeps `.env` ignored but tracks `.env.example`.
- [ ] README: what it is, `pnpm install`, `pnpm demo`, open the URL, what is real vs stand-in. Short.
- [ ] Verify: `pnpm demo` starts with no `.env`.

### Task 14: Live page works end to end (stub agents, fork)

**Files:** Modify `web/ledger.js`, `web/ledger.css` as defects surface. Scratch scripts only for the browser run.

- [ ] Start `pnpm demo` with `OUTBID_ADVERSARY=1`. Drive the page with Playwright: Start auction, watch paddles, delivery, ledger; Start twice quickly (second is refused with a clear message); fast-forward turns "Settling" into "Final"; Revoke needs two clicks and then blocks the next auction; reload mid-round replays history.
- [ ] Fix each defect found; each fix gets a unit test when it is server-side, a screenshot when it is visual.
- [ ] Verify: ledger line with what was exercised; no stray anvil.

### Task 15: `digest` job kind

**Files:** Modify `src/arena/types.ts`, `src/skills/skill.ts`, `src/skills/claude.ts`, `src/server/app.ts`, `web/index.html`, `web/ledger.js`. Test `test/skills/stub.test.ts`, `test/server/app.test.ts`.

**Interfaces:** `TaskKind` gains `"digest"`. `DIGEST_PARTS: readonly ["summarize","translate"]` exported from `types.ts`.

- [ ] Test: `stubSkill("digest").run` returns the stub translation of the stub summary; `stubGrader` scores it 1 against itself. Test: `POST /api/rounds` accepts `digest`, still rejects unknown kinds.
- [ ] Implement; Claude instruction for digest: summarize in one or two sentences, then translate into French, reply with the French summary only. UI gets a fourth kind "Brief" (summarize + translate) and a sample text.

### Task 16: `hire.*` events and the ledger

**Files:** Modify `src/arena/events.ts`, `src/arena/ledger.ts`. Test `test/arena/events.test.ts`, `test/arena/ledger.test.ts`.

**Interfaces:** `{type:"hire.started"; rfqId; from; to; part: TaskKind}`, `{type:"hire.paid"; rfqId; from; to; hash; amount}`, `{type:"hire.delivered"; rfqId; from; to}`. `RoundView.hires: { to: string; part: TaskKind; amount?: string; hash?: Hex; delivered: boolean }[]`.

- [ ] Test: the reducer folds the three events into `hires` in order; a round with none has `hires: []`.

### Task 17: Seller hires a partner

**Files:** Modify `src/agents/seller.ts`. Test `test/agents/hire.test.ts` (own file: needs a fork).

**Interfaces:**
- `Seller.quote(task: Task): string | null` — the price it would bid, or null if it cannot.
- `SellerConfig.hires?: { kind: TaskKind; own: TaskKind; partner: () => Seller }` — the job kind it can take by doing `own` itself and hiring `partner` for the other part of `DIGEST_PARTS`.
- `fulfil(bid, evidence)`: `evidence.policyId` becomes optional; `evidence.quiet?: boolean` suppresses `work.*` events (used when a partner is hired).

- [ ] Tests (RED first): (1) a specialist bids on `digest` at its own price plus the partner's quote; (2) after the buyer pays it, `fulfil` runs its part, requests an invoice from the partner naming itself as payer, pays it from its own wallet, the partner verifies and delivers, and the output is the composed result; the partner's balance rises by its price; events `hire.started`, `hire.paid`, `hire.delivered` in order and no partner `work.*`; (3) a partner invoice with the wrong payer, wrong recipient or an amount over 0.10 is refused and nothing is paid; (4) partner returns null or payment is refused: `SellerError("hire_failed")`, no money moved; (5) a replayed partner payment cannot fulfil twice.
- [ ] Implement. The hirer verifies the partner's invoice against its own address and a cap before paying; payment errors other than `refused`/`reverted`/`no_gas` are "uncertain" and fail the hire without a retry.
- [ ] Fork funding: `startArena` gives every seller wallet gas (CELO) via `anvil_setBalance` (fork only, behind `assertLocalAnvil`).

### Task 18: Round with a hire, and the roster

**Files:** Modify `src/skills/claude.ts` (roster), `src/app.ts`. Test `test/arena/round-hire.test.ts` (own file).

- [ ] Roster: the three generalists get a `digest` skill (summarize then translate) at 1.5× their price, capped at 10¢; Gist hires Lex for the translate half and Lex hires Gist for the summarize half; their digest quote is their own half plus the partner's half price, so they are competitive. Tune so each specialist wins a digest round some of the time, ledger the numbers.
- [ ] Test: a full `runRound` for `digest` with a specialist winner: `round.ended delivered`, grade recorded for the winner only, `hire.*` events present, the buyer was debited once, and the specialist's wallet paid the partner. Test: partner refuses mid-hire: round `aborted` with `hire_failed`, buyer debited once, no second payment.
- [ ] `/api/state` sellers list shows `digest` among the hirers' kinds.

### Task 19: The hiring moment in the UI

**Files:** Modify `web/ledger.js`, `web/ledger.css`, `scripts/record-fixture.ts`, `web/fixtures/round.json`.

- [ ] On `hire.started` the winner's paddle reaches toward the partner's seat (thin line); on `hire.paid` a second coin flies winner → partner; the partner's seat gets a "hired" chip and its paddle rises a little; the slip says what went to the helper ("0.03 of that went to Lex"). Sentence line narrates it.
- [ ] Re-record the fixture with a digest round where a specialist wins and hires. Screenshot at desktop and phone.

### Task 20: Mainnet env, funding checker, proof runner

**Files:** Create `src/chain/mainnet.ts`, `scripts/funding.ts`, `scripts/proof.ts`. Modify `src/live.ts`, `src/app.ts`, `package.json`. Test `test/live.test.ts`, `test/chain/mainnet.test.ts`.

**Interfaces:** `startMainnet(env, rpcUrl?)` returns the same shape as `ArenaEnv` minus `mine`; refuses unless `preflight(env, chainId)` is ok and the RPC reports chain 42220. Seller keys come from `OUTBID_SELLER_MNEMONIC` (must not be a public phrase).

- [ ] Tests (no network): preflight rejects public seller mnemonics and missing vars; `startMainnet` refuses without the flags before any RPC call; `scripts/funding.ts` computes the required balances from the roster.
- [ ] `pnpm funding`: prints every address (owner, buyer, sellers) with its role, the USDT and CELO each needs, and current balances — read-only, sends nothing.
- [ ] `pnpm proof`: after funding, runs three real rounds (summarize, translate, digest with a hire) with Claude agents, a policy budget of at most 1.00 USDT, waits for finality, writes `web/fixtures/proof.json` with transaction hashes. Refuses to start unless funding is sufficient and the owner passed both flags.
- [ ] Explorer links: tx hashes in the UI become celoscan links when the network is mainnet or in proof mode; `/?proof` loads `proof.json` and shows a "Verified on Celo mainnet" mark.

### Task 21: Final verification and review

- [ ] Full suite and typecheck green, no stray anvil. Fresh-context whole-branch review on the most capable model with the Review Focus above and the ledger's Ruling lines. One fix pass, RED→GREEN each. Final message lists "Rulings I made" and "Deferred minors".
