import { reduceLedger } from "./vendor/ledger.js";

/* ---------- constants ---------- */
const SAMPLES = {
  translate: "Good morning. The shipment arrives on Friday and the invoice is attached to this message.",
  summarize:
    "The committee reviewed the quarterly numbers and agreed that revenue growth was ahead of plan across every region, while margins also improved thanks to lower shipping costs.",
  extract: "Maria Okafor signed the lease for the Lagos warehouse on 3 March, paying a deposit of 4,500 USDT through the escrow contract.",
  digest:
    "Customers praised the new checkout flow, but several reported that the confirmation email arrived late and that refunds took longer than the promised three days. Support volume doubled in the week after launch.",
};
const REASONS = {
  wrong_payer: "wrong payer",
  invalid_signature: "forged signature",
  expired: "expired",
  wrong_recipient: "wrong recipient",
  over_budget: "over budget",
  late: "too late",
  wrong_order: "old invoice",
};
const CHEATS = { Sly: "names the wrong payer", Fakir: "tampers with the price" };
const STAGES = ["Ask", "Bids", "Pick", "Pay", "Deliver", "Grade", "Final"];
const DIMS = [
  { key: "price", label: "Price", cls: "p", color: "var(--price)" },
  { key: "speed", label: "Speed", cls: "s", color: "var(--speed)" },
  { key: "record", label: "Track record", cls: "r", color: "var(--record)" },
];
const DEFAULT_W = { price: 50, speed: 20, record: 30 };
const PRESETS = [
  { name: "Buyer's mix", w: DEFAULT_W },
  { name: "Cheapest", w: { price: 80, speed: 10, record: 10 } },
  { name: "Fastest", w: { price: 10, speed: 80, record: 10 } },
  { name: "Most proven", w: { price: 10, speed: 10, record: 80 } },
];
const PACE = {
  "rfq.opened": 900, "bid.received": 560, "bid.rejected": 700, "winner.chosen": 2300, "payment.sent": 1200,
  "payment.included": 800, "work.started": 500, "hire.started": 1100, "hire.paid": 1500, "hire.delivered": 800, "work.delivered": 1100, "result.graded": 900, "round.ended": 2600,
  "payment.final": 500, "policy.revoked": 800,
};
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const KIND_SVG = {
  translate: svg('<path d="M4 5h9M8.5 3v2M6 5c.6 3.2 2.6 5.6 5.5 7M12 5c-.8 3.6-3.4 6.2-7 7.5"/><path d="M13 20l4-10 4 10M14.4 16.5h5.2"/>'),
  summarize: svg('<path d="M4 6h16M4 12h10M4 18h6"/>'),
  extract: svg('<path d="M8 4H5a1 1 0 00-1 1v3M16 4h3a1 1 0 011 1v3M8 20H5a1 1 0 01-1-1v-3M16 20h3a1 1 0 001-1v-3"/><path d="M9 12h6"/>'),
  digest: svg('<path d="M4 6h10M4 11h6M16 13l4 4-4 4M20 17h-9"/>'),
};
const ICON = {
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  play: svg('<path d="M7 5l11 7-11 7z"/>'),
  again: svg('<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/>'),
};
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- state ---------- */
const S = {
  mode: "replay", proof: false, events: [], sellers: [], network: "fork", agents: "stub",
  policy: { perPayment: 0.5, perDay: 5 }, selected: null, kind: "summarize", edited: false, draft: false,
  w: { ...DEFAULT_W }, instant: false, player: null, shown: { value: null, raf: 0, slip: null, sig: "" },
};

/* ---------- tiny helpers ---------- */
const $ = (selector) => document.querySelector(selector);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "html") el.innerHTML = value ?? ""; // only ever our own constant SVG strings
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const money = (n) => Number(n).toFixed(2);
const num = (text) => Number.parseFloat(String(text));
const EXPLORER = "https://celoscan.io/tx/";
const onMainnet = () => S.network === "mainnet";
const shortHash = (hash) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sameW = (a, b) => a.price === b.price && a.speed === b.speed && a.record === b.record;
const avatar = (name) => h("span", { class: "av" }, name[0]);
const PART = { translate: "translation", summarize: "summary", extract: "extraction" };
const part = (kind) => PART[kind] ?? kind;
const skills = (kinds) => (kinds.length >= 3 ? "any job" : kinds.join(" and "));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fillOf = (input) => `${((input.value - input.min) / (input.max - input.min)) * 100}%`;

/* ---------- derive everything from the event log ---------- */
function detail(rfqId) {
  const d = { rfqId, rfq: null, bids: new Map(), winner: null, price: null, scores: [], hash: null, included: false, final: false, delivered: false, output: null, grade: null, ended: null, reason: null, hires: [] };
  for (const e of S.events) {
    if (e.type === "rfq.opened") { if (e.rfq.id === rfqId) d.rfq = e.rfq; continue; }
    if (e.rfqId !== rfqId) continue;
    if (e.type === "bid.received") d.bids.set(e.seller, { price: e.price, etaMs: e.etaMs });
    else if (e.type === "bid.rejected") d.bids.set(e.seller, { price: e.price, rejected: e.reason });
    else if (e.type === "winner.chosen") Object.assign(d, { winner: e.seller, price: e.price, scores: e.scores });
    else if (e.type === "payment.sent") Object.assign(d, { hash: e.hash, paid: e.amount });
    else if (e.type === "payment.included") d.included = true;
    else if (e.type === "payment.final") d.final = true;
    else if (e.type === "hire.started") d.hires.push({ from: e.from, to: e.to, part: e.part, amount: null, hash: null, delivered: false });
    else if (e.type === "hire.paid") Object.assign(d.hires.at(-1) ?? {}, { amount: e.amount, hash: e.hash });
    else if (e.type === "hire.delivered") Object.assign(d.hires.at(-1) ?? {}, { delivered: true });
    else if (e.type === "work.delivered") Object.assign(d, { delivered: true, output: e.output });
    else if (e.type === "result.graded") d.grade = e.grade;
    else if (e.type === "round.ended") Object.assign(d, { ended: e.status, reason: e.reason });
  }
  return d;
}

function reputations() {
  const book = new Map();
  for (const e of S.events) {
    if (e.type !== "result.graded") continue;
    const r = book.get(e.seller) ?? { jobs: 0, total: 0 };
    book.set(e.seller, { jobs: r.jobs + 1, total: r.total + e.grade });
  }
  return book;
}

const spent = () => S.events.reduce((sum, e) => (e.type === "payment.sent" ? sum + num(e.amount) : sum), 0);
const revoked = () => S.events.some((e) => e.type === "policy.revoked");
const openRound = () => {
  const last = [...S.events].reverse().find((e) => e.type === "rfq.opened");
  return Boolean(last) && !S.events.some((e) => e.type === "round.ended" && e.rfqId === last.rfq.id);
};

/** The what-if: the buyer's recorded score parts, weighed again. Ties go to the lower price, then the name. */
function rescore(rows, w) {
  const total = w.price + w.speed + w.record || 1;
  return rows
    .map((r) => ({ ...r, s: (w.price * r.parts.price + w.speed * r.parts.speed + w.record * r.parts.record) / total }))
    .sort((a, b) => (Math.abs(b.s - a.s) > 1e-9 ? b.s - a.s : num(a.price) - num(b.price) || a.seller.localeCompare(b.seller)));
}

function sentence(d) {
  if (!d?.rfq) return S.mode === "live" ? "Write a job, set a budget, start the auction." : "Loading the recording…";
  const bids = [...d.bids.entries()];
  const ok = bids.filter(([, b]) => !b.rejected).length;
  const bad = bids.filter(([, b]) => b.rejected);
  const out = bad.length ? ` Thrown out: ${bad.map(([n, b]) => `${n} (${REASONS[b.rejected] ?? b.rejected})`).join(", ")}.` : "";
  if (d.ended === "aborted") return `Stopped. ${d.reason ?? ""}`.trim();
  if (d.ended === "no_winner") return `No valid bid inside the budget.${out}`;
  const help = d.hires[0];
  const shared = help?.amount ? ` ${money(num(help.amount))} of it went to ${help.to}.` : "";
  if (d.final) return `Settled. ${d.winner} was paid ${money(num(d.price))} and the payment is final.${shared}`;
  if (d.grade != null) return `${d.winner}'s work graded ${money(d.grade)}. Waiting for the payment to settle.${shared}`;
  if (d.delivered) return help ? `${d.winner} delivered, with ${help.to}'s ${part(help.part)} inside. Grading it now.` : `${d.winner} delivered. Grading it now.`;
  if (help?.delivered) return `${help.to} sent back the ${part(help.part)}. ${d.winner} puts it together.`;
  if (help?.hash) return `${d.winner} paid ${help.to} ${money(num(help.amount))} for the ${part(help.part)}.`;
  if (help) return `${d.winner} does its half and hires ${help.to} for the ${part(help.part)}.`;
  if (d.included) return `Paid. ${d.winner} checks the payment on-chain, then starts work.`;
  if (d.hash) return `Paying ${d.winner} from your spending limit.`;
  if (d.winner) return `${d.winner} takes it at ${money(num(d.price))}.${out}`;
  if (bids.length) return `${ok} sealed bid${ok === 1 ? "" : "s"} in.${out}`;
  return "Sellers are signing their bids.";
}

/* ---------- top bar + the job ---------- */
function renderBar() {
  const net = $("#net");
  net.textContent = !onMainnet() ? "Practice chain, no real money" : S.proof ? "Verified on Celo mainnet" : "Celo mainnet, real money";
  net.className = `pill ${!onMainnet() ? "" : S.proof ? "proof" : "live"}`;
  $("#mode").textContent = S.agents === "claude" ? "Claude agents" : "Stand-in agents";
  const used = spent();
  $("#g-used").textContent = money(used);
  $("#g-of").textContent = `of ${money(S.policy.perDay)} today`;
  $("#g-bar").style.width = `${clamp((used / S.policy.perDay) * 100, used > 0 ? 2 : 0, 100)}%`;
  $("#gauge").title = `Up to ${money(S.policy.perPayment)} USDT per job`;
  const btn = $("#revoke");
  btn.disabled = S.mode !== "live" || revoked();
  btn.textContent = revoked() ? "Revoked" : "Revoke";
  if (revoked()) banner("Spending limit revoked. The buyer agent can no longer pay anyone.", "bad");
}

function renderLot(d) {
  const live = S.mode === "live";
  const running = openRound();
  if (!live && d?.rfq) {
    S.kind = d.rfq.task.kind;
    $("#input").value = d.rfq.task.input;
    $("#budget").value = d.rfq.budget;
  } else if (!S.edited && !$("#input").value) $("#input").value = SAMPLES[S.kind];
  const lots = S.events.filter((e) => e.type === "rfq.opened");
  const lotNo = live ? lots.length + (running ? 0 : 1) : Math.max(1, lots.findIndex((e) => e.rfq.id === d?.rfqId) + 1);
  $("#lot-no").textContent = `Lot ${lotNo}`;
  $("#lot-state").textContent = !live ? "Recording" : running ? "Bidding open" : "Ready";
  $("#lot").classList.toggle("locked", !live);
  $("#input").readOnly = !live;
  $("#budget").disabled = !live;
  $("#budget").style.setProperty("--fill", fillOf($("#budget")));
  $("#budget-val").textContent = money($("#budget").value);
  for (const b of document.querySelectorAll("#kinds button")) {
    b.setAttribute("aria-checked", String(b.dataset.kind === S.kind));
    b.disabled = !live;
  }
  const run = $("#run");
  run.disabled = !live || running || revoked();
  run.classList.toggle("running", live && running);
  $("#run-text").textContent = !live ? "Replaying real auctions" : revoked() ? "Spending limit revoked" : running ? "Auction running" : "Start auction";
  $("#job-hint").textContent = live
    ? `One payment can never pass ${money(S.policy.perPayment)} USDT. The limit is enforced on-chain.`
    : S.proof
      ? "This is a recording of a real-money run on Celo mainnet. Every payment opens on Celoscan."
      : "This is a recording of real auctions on a practice chain. Run the demo to start your own.";
}

/* ---------- the money ---------- */
function tween(to) {
  const el = $("#num");
  const from = S.shown.value ?? to;
  S.shown.value = to;
  cancelAnimationFrame(S.shown.raf);
  if (calm || from === to) { el.textContent = money(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 1000);
    el.textContent = money(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) S.shown.raf = requestAnimationFrame(step);
  };
  S.shown.raf = requestAnimationFrame(step);
}

function renderPrice(d) {
  let target = num($("#budget").value);
  let cap = "budget";
  let sold = false;
  if (d?.rfq && !(S.mode === "live" && S.draft)) {
    target = num(d.rfq.budget);
    if (d.winner && d.price) { target = num(d.price); cap = "hammer price"; sold = true; }
    else if (d.ended === "no_winner") cap = "no deal";
    else if (d.ended === "aborted") cap = "stopped";
  }
  $("#price").classList.toggle("sold", sold);
  $("#price-cap").textContent = cap;
  const saved = $("#saved");
  const diff = sold ? num(d.rfq.budget) - num(d.price) : 0;
  saved.hidden = diff <= 0;
  if (diff > 0) saved.textContent = `saved ${money(diff)}`;
  tween(target);
  $("#say").textContent = sentence(S.mode === "live" && S.draft ? null : d);
}

/* ---------- the room ---------- */
const seatEls = new Map();

function buildSeats() {
  const room = $("#room");
  const key = S.sellers.map((s) => s.name).join();
  if (room.dataset.key === key) return;
  room.dataset.key = key;
  seatEls.clear();
  room.querySelectorAll(".seat").forEach((n) => n.remove());
  for (const s of S.sellers) {
    const el = h("div", { class: `seat${CHEATS[s.name] ? " cheat" : ""}`, "data-seller": s.name, role: "img" },
      h("div", { class: "paddle" },
        h("div", { class: "disc" }, h("b"), h("small"), h("span", { class: "badge", html: CHECK })),
        h("div", { class: "stick" })),
      h("div", { class: "foot" },
        h("div", { class: "who" }, avatar(s.name), h("b", {}, s.name)),
        h("small", { class: "rec" }),
        h("div", { class: "mix" }, h("i", { class: "p" }), h("i", { class: "s" }), h("i", { class: "r" })),
        h("small", { class: "why" })));
    seatEls.set(s.name, el);
    room.append(el);
  }
}

function renderRoom(d) {
  buildSeats();
  const rows = d?.scores.length ? rescore(d.scores, S.w) : [];
  const byName = new Map(rows.map((r) => [r.seller, r]));
  const lo = rows.length ? Math.min(...rows.map((r) => r.s)) : 0;
  const hi = rows.length ? Math.max(...rows.map((r) => r.s)) : 1;
  const leader = rows[0]?.seller;
  const closed = Boolean(d && (d.winner || d.ended));
  const rep = reputations();
  const total = S.w.price + S.w.speed + S.w.record || 1;
  const help = d?.hires[0];

  S.sellers.forEach((s, i) => {
    const el = seatEls.get(s.name);
    const bid = d?.bids.get(s.name);
    const row = byName.get(s.name);
    const bad = Boolean(bid?.rejected);
    const won = d?.winner === s.name && !bad;
    const would = Boolean(row) && leader === s.name && d.winner !== s.name;
    const hired = help?.to === s.name;
    el.classList.toggle("in", Boolean(bid) || hired);
    el.classList.toggle("hired", hired);
    el.classList.toggle("bad", bad);
    el.classList.toggle("scored", Boolean(row));
    el.classList.toggle("won", won);
    el.classList.toggle("would", would);
    el.classList.toggle("lost", Boolean(row) && !won && !would);
    el.classList.toggle("out", !bid && !hired && closed);
    el.classList.toggle("is-paid", won && Boolean(d.hash));
    el.style.setProperty("--d", S.instant ? "0s" : `${i * 60}ms`);
    el.style.setProperty("--h", hired ? 0.5 : bid ? (bad ? 0.42 : row ? (hi > lo ? 0.2 + 0.8 * ((row.s - lo) / (hi - lo)) : 0.62) : 0.42) : 0);

    // A hired helper never bid: its paddle shows what the winner paid it.
    el.querySelector(".disc b").textContent = hired ? (help.amount ? money(num(help.amount)) : "…") : bid ? (bid.price ? money(num(bid.price)) : "?") : "";
    el.querySelector(".disc small").textContent = hired ? "hired" : bid?.etaMs ? `${(bid.etaMs / 1000).toFixed(1)}s` : "";
    const r = rep.get(s.name);
    el.querySelector(".rec").textContent = CHEATS[s.name] ? "cheater" : r ? `${money(r.total / r.jobs)} avg` : "new";
    el.querySelector(".why").textContent = bad ? REASONS[bid.rejected] ?? bid.rejected : hired ? `hired by ${help.from}` : would ? "would win" : "";
    el.title = CHEATS[s.name] ? `${s.name} ${CHEATS[s.name]}` : `${s.name} does ${skills(s.kinds)}, usually in ${(s.etaMs / 1000).toFixed(1)}s`;
    el.setAttribute("aria-label", bid ? `${s.name}, ${bad ? REASONS[bid.rejected] : `bid ${bid.price}`}` : `${s.name}, no bid`);

    if (row) {
      const part = (key, share) => `${(share * row.parts[key] * 100) / (hi || 1) / total}%`;
      el.querySelector(".mix .p").style.width = part("price", S.w.price);
      el.querySelector(".mix .s").style.width = part("speed", S.w.speed);
      el.querySelector(".mix .r").style.width = part("record", S.w.record);
    }
  });
  renderLink(help);
}

/** A thin dashed line from the winner's paddle to the helper it hired. */
function renderLink(help) {
  const link = $("#link");
  const a = help && discBox(help.from);
  const b = help && discBox(help.to);
  link.toggleAttribute("hidden", !(a && b));
  if (!(a && b)) { link.dataset.key = ""; return; }
  const lift = Math.min(a.top, b.top) - 34;
  link.querySelector("path").setAttribute("d", `M ${a.cx} ${a.top} C ${a.cx} ${lift}, ${b.cx} ${lift}, ${b.cx} ${b.top}`);
  const key = `${help.from}>${help.to}`;
  if (link.dataset.key !== key) {
    link.dataset.key = key;
    if (!calm) link.querySelector("path").animate([{ strokeDashoffset: 600 }, { strokeDashoffset: 0 }], { duration: S.instant ? 0 : 900, easing: "ease-out" });
  }
}

/* ---------- the dock ---------- */
function renderDock(d) {
  const done = [Boolean(d?.rfq), Boolean(d && (d.winner || d.ended)), Boolean(d?.hash), Boolean(d?.included), Boolean(d?.delivered), d?.grade != null, Boolean(d?.final)];
  const now = done.indexOf(false);
  const failed = Boolean(d && (d.ended === "aborted" || d.ended === "no_winner"));
  const chips = $("#stages");
  if (!chips.children.length) chips.replaceChildren(...STAGES.map((label, i) => h("li", { class: i === 6 ? "final" : "" }, label)));
  [...chips.children].forEach((li, i) => {
    li.classList.toggle("done", done[i]);
    li.classList.toggle("now", i === now && !failed);
    li.classList.toggle("bad", i === now && failed);
  });
  $("#ctrl").hidden = S.mode !== "replay";
}

/* ---------- what if ---------- */
function buildWhatIf() {
  $("#presets").replaceChildren(
    ...PRESETS.map((p) => h("button", { type: "button", "aria-pressed": "false", onclick: () => setWeights(p.w) }, p.name)),
  );
  $("#dials").replaceChildren(
    ...DIMS.map((dim) => {
      const input = h("input", { type: "range", min: 0, max: 100, step: 1, value: S.w[dim.key], "aria-label": `${dim.label} weight`, "data-key": dim.key });
      input.style.setProperty("--c", dim.color);
      input.addEventListener("input", () => { S.w[dim.key] = Number(input.value); weightsChanged(); });
      return h("label", { class: "dial", style: `--c:${dim.color}` }, h("b", {}, dim.label), input, h("output"));
    }),
  );
}

function setWeights(w) { S.w = { ...w }; weightsChanged(); }
function weightsChanged() {
  S.instant = true;
  const d = S.selected ? detail(S.selected) : null;
  renderRoom(d);
  renderWhatIf(d);
  requestAnimationFrame(() => { S.instant = false; });
}

function renderWhatIf(d) {
  const total = S.w.price + S.w.speed + S.w.record || 1;
  for (const input of document.querySelectorAll("#dials input")) {
    const key = input.dataset.key;
    if (Number(input.value) !== S.w[key]) input.value = S.w[key];
    input.style.setProperty("--fill", fillOf(input));
    input.parentElement.querySelector("output").textContent = `${Math.round((S.w[key] / total) * 100)}`;
  }
  const bar = $("#mixbar");
  DIMS.forEach((dim) => { bar.querySelector(`.${dim.cls}`).style.width = `${(S.w[dim.key] / total) * 100}%`; });
  [...$("#presets").children].forEach((b, i) => b.setAttribute("aria-pressed", String(sameW(PRESETS[i].w, S.w))));

  const rows = d?.scores.length ? rescore(d.scores, S.w) : [];
  const verdict = $("#verdict");
  const reset = sameW(S.w, DEFAULT_W) ? null : h("button", { class: "reset", type: "button", onclick: () => setWeights(DEFAULT_W) }, "Reset");
  if (!rows.length) verdict.replaceChildren("Drag a slider once an auction has been scored.");
  else if (rows[0].seller === d.winner) verdict.replaceChildren(...[h("em", {}, "Same winner"), `${d.winner} comes first either way.`, reset].filter(Boolean));
  else verdict.replaceChildren(...[h("em", {}, "Different winner"), `${rows[0].seller} would take it. ${d.winner} was paid.`, reset].filter(Boolean));
}

/* ---------- the delivery slip ---------- */
function renderSlip(d) {
  const has = Boolean(d && (d.hash || d.delivered));
  $("#slip-empty").hidden = has;
  $("#slip-body").hidden = !has;
  const slip = $("#slip");
  slip.classList.toggle("final", has && d.final);
  if (!has) { S.shown.slip = null; return; }
  if (S.shown.slip !== d.rfqId) {
    S.shown.slip = d.rfqId;
    slip.classList.remove("drop");
    void slip.offsetWidth;
    slip.classList.add("drop");
  }
  const av = $("#res-av");
  av.textContent = d.winner?.[0] ?? "";
  $("#res-who").textContent = d.winner ?? "";
  // A round can stop after the winner was already paid (its helper failed, say): the money moved, the work did not.
  const stopped = d.ended === "aborted" && !d.delivered;
  $("#res-sub").textContent = d.delivered ? "delivered" : stopped ? "stopped" : "working on it";
  $("#res-out").textContent = d.output ?? (stopped ? d.reason ?? "The auction stopped." : "Working…");
  const grade = $("#res-grade");
  grade.style.setProperty("--g", d.grade != null ? d.grade * 100 : 0);
  grade.querySelector("b").textContent = d.grade != null ? money(d.grade) : "–";
  $("#res-paid").textContent = d.paid ? money(num(d.paid)) : "–";
  const help = d.hires[0];
  $("#res-hire").hidden = !help?.amount;
  if (help?.amount) {
    const link = onMainnet() && help.hash ? h("a", { href: `${EXPLORER}${help.hash}`, target: "_blank", rel: "noopener" }, "See that payment") : null;
    $("#res-hire").replaceChildren(...[`${money(num(help.amount))} of that went to ${help.to}, hired for the ${part(help.part)}. `, link].filter(Boolean));
  }
  const hash = $("#res-hash");
  hash.textContent = d.hash ? shortHash(d.hash) : "–";
  hash.dataset.hash = d.hash ?? "";
  hash.title = onMainnet() ? "Open this payment on Celoscan" : "Copy transaction hash";
  $("#res-final").textContent = stopped ? "Paid, not delivered" : d.final ? "Final" : d.included ? "Included, settling" : "Sending";
  $("#ff").hidden = !(S.mode === "live" && S.network === "fork" && d.included && !d.final);
}

/* ---------- the tickets ---------- */
function renderTickets() {
  const rounds = reduceLedger(S.events).rounds;
  const sig = JSON.stringify([rounds.map((r) => [r.rfqId, r.status, r.final, r.grade, r.winner]), S.selected]);
  if (sig === S.shown.sig) return;
  S.shown.sig = sig;
  const box = $("#tickets");
  if (!rounds.length) { box.replaceChildren(h("div", { class: "ticket-empty" }, "Your first auction prints a ticket here.")); return; }
  box.replaceChildren(
    ...rounds.map((r, i) => ({ r, n: i + 1 })).reverse().map(({ r, n }) => {
      const stopped = r.status === "aborted" || r.status === "no_winner";
      const paid = [...S.events].reverse().find((e) => e.type === "payment.sent" && e.rfqId === r.rfqId)?.amount;
      const [label, cls] = stopped ? [r.status === "aborted" ? "Stopped" : "No bids", "bad"] : r.final ? ["Final", "final"] : ["Settling", ""];
      return h("div", { class: `ticket-w${r.rfqId === S.selected ? " sel" : ""}` },
        h("button", { class: "ticket", type: "button", title: r.task.input, "aria-current": r.rfqId === S.selected ? "true" : null, onclick: () => select(r.rfqId) },
          h("div", { class: "tk-top" }, h("span", {}, `Lot ${n}`), h("span", { html: KIND_SVG[r.task.kind] })),
          h("div", { class: "tk-mid" }, r.winner ? avatar(r.winner) : null, h("b", {}, paid ? money(num(paid)) : "–")),
          h("div", { class: "tk-bot" }, h("span", { class: `tk-st ${cls}` }, label), h("span", {}, r.grade != null ? `${money(r.grade)} graded` : ""))));
    }),
  );
}

function render() {
  const d = S.selected ? detail(S.selected) : null;
  renderBar();
  renderLot(d);
  renderPrice(d);
  renderRoom(d);
  renderDock(d);
  renderWhatIf(d);
  renderSlip(d);
  renderTickets();
}
let scheduled = false;
addEventListener("resize", () => renderSoon());
function renderSoon() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}
function select(rfqId) {
  S.selected = rfqId;
  render();
}

/* ---------- fx: gavel, ripple, coin ---------- */
let fx = Promise.resolve();
const later = (fn) => { fx = fx.then(fn).catch(() => {}); };

function discBox(name) {
  const disc = seatEls.get(name)?.querySelector(".disc");
  if (!disc) return null;
  const st = $("#stage").getBoundingClientRect();
  const r = disc.getBoundingClientRect();
  return { cx: r.left - st.left + r.width / 2, cy: r.top - st.top + r.height / 2, top: r.top - st.top, st };
}

function ripple(cx, cy) {
  const ring = h("div", { class: "ring" });
  ring.style.left = `${cx}px`;
  ring.style.top = `${cy}px`;
  $(".fx").append(ring);
  ring.animate([{ transform: "scale(0.5)", opacity: 0.85 }, { transform: "scale(2.5)", opacity: 0 }], { duration: 750, easing: "ease-out" }).finished.then(() => ring.remove());
}

async function strike(name) {
  const b = discBox(name);
  if (!b) return;
  const g = $("#gavel");
  g.style.left = `${b.cx - 36}px`;
  g.style.top = `${b.top - 47}px`;
  g.removeAttribute("hidden");
  const anim = g.animate(
    [
      { transform: "rotate(42deg)", opacity: 0 },
      { transform: "rotate(42deg)", opacity: 1, offset: 0.2 },
      { transform: "rotate(-6deg)", opacity: 1, offset: 0.45 },
      { transform: "rotate(3deg)", opacity: 1, offset: 0.55 },
      { transform: "rotate(-5deg)", opacity: 1, offset: 0.65 },
      { transform: "rotate(-5deg)", opacity: 1, offset: 0.85 },
      { transform: "rotate(-5deg)", opacity: 0 },
    ],
    { duration: 1300, easing: "ease-in-out" },
  );
  setTimeout(() => {
    ripple(b.cx, b.cy);
    const stage = $("#stage");
    stage.classList.remove("thunk");
    void stage.offsetWidth;
    stage.classList.add("thunk");
  }, 585);
  await anim.finished;
  g.setAttribute("hidden", "");
}

async function flyCoin(name, fromName) {
  const b = discBox(name);
  if (!b) return;
  const lot = $("#lot").getBoundingClientRect();
  const origin = fromName && discBox(fromName);
  const from = origin ? { x: origin.cx, y: origin.cy } : { x: lot.right - b.st.left - 16, y: lot.top - b.st.top + 70 };
  const coin = $("#coin");
  coin.hidden = false;
  const anim = coin.animate(
    [
      { transform: `translate(${from.x}px, ${from.y}px) scale(0.5)`, opacity: 0 },
      { transform: `translate(${(from.x + b.cx) / 2}px, ${Math.min(from.y, b.cy) - 80}px) scale(1.15)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${b.cx}px, ${b.cy}px) scale(0.8)`, opacity: 1 },
    ],
    { duration: 900, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
  );
  await anim.finished;
  coin.hidden = true;
}

function fxFor(e) {
  if (calm || S.player?.fast) return;
  if (e.type === "winner.chosen") later(async () => { await wait(1000); if (S.selected === e.rfqId) await strike(e.seller); });
  else if (e.type === "payment.sent") later(async () => { if (S.selected === e.rfqId) await flyCoin(e.seller); });
  else if (e.type === "hire.paid") later(async () => { if (S.selected === e.rfqId) await flyCoin(e.to, e.from); });
}

/* ---------- events in ---------- */
function push(event) {
  S.events.push(event);
  if (event.type === "rfq.opened") { S.selected = event.rfq.id; S.draft = false; }
  if (S.mode === "live" && ["round.ended", "payment.final", "policy.revoked"].includes(event.type)) refreshState();
  renderSoon();
  fxFor(event);
}

let bannerTimer;
function banner(text, kind = "bad", ms = 0) {
  const el = $("#banner");
  el.hidden = false;
  el.className = `banner ${kind === "info" ? "info" : ""}`;
  el.replaceChildren(h("div", {}, text));
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- live mode ---------- */
async function refreshState() {
  const res = await fetch("/api/state");
  if (!res.ok) return;
  const st = await res.json();
  S.sellers = st.sellers;
  S.network = st.network;
  S.agents = st.mode;
  S.policy = { perPayment: num(st.policy.perPayment), perDay: num(st.policy.perDay) };
  renderSoon();
}

async function post(path, body = {}) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) banner((await res.json().catch(() => ({}))).error ?? "Something went wrong.", "bad", 4000);
  return res;
}

function startLive() {
  S.mode = "live";
  refreshState().then(() => {
    const source = new EventSource("/api/events");
    // The server replays its whole history on every (re)connect, so start from scratch after a drop.
    let dropped = false;
    source.onerror = () => { dropped = true; };
    source.onmessage = (message) => {
      if (dropped) { dropped = false; S.events = []; S.selected = null; S.shown.sig = ""; }
      push(JSON.parse(message.data));
    };
  });
}

/* ---------- replay mode ---------- */
function startReplay(fixture) {
  S.mode = "replay";
  document.body.classList.add("replay");
  S.sellers = fixture.state.sellers;
  S.network = fixture.state.network;
  S.agents = fixture.mode;
  S.policy = { perPayment: num(fixture.state.policy.perPayment), perDay: num(fixture.state.policy.perDay) };

  const P = (S.player = { events: fixture.events, i: 0, paused: false, speed: 1, fast: false, timer: null, done: false });
  const setPlay = (icon, label) => { $("#play").innerHTML = ICON[icon]; $("#play").setAttribute("aria-label", label); };
  const tick = () => {
    if (P.i >= P.events.length) { P.done = true; setPlay("again", "Replay again"); return; }
    const event = P.events[P.i++];
    if (event.type === "rfq.opened") P.fast = false;
    if (!S.proof && event.type === "payment.final" && P.events[P.i - 2]?.type !== "payment.final") banner("Fast-forwarded about 25 minutes of chain time. Payments are now final.", "info", 3800);
    push(event);
    P.timer = setTimeout(() => { if (!P.paused) tick(); }, P.fast ? 0 : (PACE[event.type] ?? 500) / P.speed);
  };
  P.resume = () => { clearTimeout(P.timer); tick(); };

  $("#play").onclick = () => {
    if (P.done) {
      S.events = []; S.selected = null; S.shown.sig = "";
      Object.assign(P, { i: 0, done: false, paused: false, fast: false });
      setPlay("pause", "Pause");
      document.querySelector("#banner").hidden = true;
      return P.resume();
    }
    P.paused = !P.paused;
    setPlay(P.paused ? "play" : "pause", P.paused ? "Play" : "Pause");
    if (!P.paused) P.resume();
  };
  $("#skip").onclick = () => {
    P.fast = true;
    if (P.paused) { P.paused = false; setPlay("pause", "Pause"); }
    P.resume();
  };
  $("#speed").onclick = () => { P.speed = P.speed === 1 ? 2 : P.speed === 2 ? 4 : 1; $("#speed").textContent = `${P.speed}×`; };
  tick();
}

/* ---------- wiring ---------- */
function wire() {
  buildWhatIf();
  for (const button of document.querySelectorAll("#kinds button")) {
    button.onclick = () => {
      if (S.mode !== "live") return;
      S.kind = button.dataset.kind;
      S.draft = true;
      if (!S.edited) $("#input").value = SAMPLES[S.kind];
      render();
    };
  }
  $("#input").oninput = () => { S.edited = true; S.draft = true; renderSoon(); };
  $("#budget").oninput = () => { S.draft = true; render(); };
  $("#run").onclick = async () => {
    $("#run").disabled = true;
    if (matchMedia("(max-width: 980px)").matches) $("#room").scrollIntoView({ behavior: "smooth", block: "center" });
    const res = await post("/api/rounds", { task: { kind: S.kind, input: $("#input").value }, budget: $("#budget").value });
    if (!res.ok) renderSoon();
  };
  let armed;
  $("#revoke").onclick = async () => {
    const btn = $("#revoke");
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.textContent = "Sure? Revoke";
      armed = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "Revoke"; }, 3000);
      return;
    }
    clearTimeout(armed);
    btn.classList.remove("armed");
    await post("/api/revoke");
  };
  $("#ff").onclick = async () => { $("#ff").disabled = true; await post("/api/fast-forward"); $("#ff").disabled = false; };
  $("#res-hash").onclick = async (event) => {
    const el = event.currentTarget;
    if (!el.dataset.hash) return;
    if (onMainnet()) return void window.open(`${EXPLORER}${el.dataset.hash}`, "_blank", "noopener");
    try { await navigator.clipboard.writeText(el.dataset.hash); } catch { return; }
    const was = el.textContent;
    el.textContent = "Copied";
    setTimeout(() => { el.textContent = was; }, 1200);
  };
}

async function boot() {
  wire();
  render();
  // ?replay and ?proof both ask for a recording, even when a demo server is answering.
  const query = new URLSearchParams(location.search);
  if (!query.has("replay") && !query.has("proof")) {
    try {
      const res = await fetch("/api/state");
      if (res.ok) return startLive();
    } catch { /* no server: fall through to the recording */ }
  }
  if (query.has("proof")) {
    const res = await fetch("fixtures/proof.json").catch(() => null);
    if (res?.ok) { S.proof = true; return startReplay(await res.json()); }
    banner("No real-money run has been recorded yet. Showing the practice-chain recording instead.", "info");
  }
  startReplay(await (await fetch("fixtures/round.json")).json());
}
boot();
