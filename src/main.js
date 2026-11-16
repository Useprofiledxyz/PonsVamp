import { formatEther, formatUnits, parseAbiItem, parseEther, parseUnits } from "viem";
import {
  DEFAULT_RPC,
  PONS_V2_FACTORY,
  logoSources,
  extractCA,
  factoryAbi,
  fetchTokenMeta,
  getWallet,
  launchVamp,
  makeChain,
  makePublicClient,
} from "./pons.js";
import * as M from "./market.js";

// ── settings / persistence ──────────────────────────────────────────────────
const DEFAULTS = {
  wallet: "injected", burner: "",
  quickBuy: "0.01", slippage: 10,
  devBuy: "0", tax: 0, buyback: true, copySocials: true, copyDesc: true, prefix: "", suffix: "",
  rpc: DEFAULT_RPC, insta: false,
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let S = { ...DEFAULTS, ...load("ponsvamp.settings", {}) };
let vampHistory = load("ponsvamp.history", []);

let chain = makeChain(S.rpc);
let client = makePublicClient(chain);

// ── app state ───────────────────────────────────────────────────────────────
const st = {
  tokens: new Map(),   // token address (lowercase) → token object
  byCurve: new Map(),  // curve address (lowercase) → token object
  order: [],           // newest first
  head: 0n,
  tradeHead: 0n,
  trades: [],
  ethUsd: null,
  launchFee: null,
  loaded: false,
  filter: "",
  conn: null,
  vamp: null,          // fetched source meta on the vamp page
  freshUntil: new Map(),
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $("#app");

// ── formatting helpers ──────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const scan = (p) => `${chain.blockExplorers.default.url}/${p}`;
const BLOCK_SEC = 0.104; // ~9.6 blocks/s on Robinhood Chain
function ago(block) {
  const s = Math.max(0, Number(st.head - block) * BLOCK_SEC);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function compact(n, pre = "") {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return pre + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return pre + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return pre + (n / 1e3).toFixed(1) + "K";
  if (a >= 1) return pre + n.toFixed(2);
  return pre + n.toPrecision(3);
}
const usd = (eth) => (st.ethUsd && eth != null ? compact(eth * st.ethUsd, "$") : eth != null ? compact(eth) + " ETH" : "—");
// Market cap text: Pons' own USD figure when we have it (covers non-ETH pairs), else ETH × price.
const mcap = (t) => (t.mcapUsd != null ? compact(t.mcapUsd, "$") : usd(t.mcapEth));
// Ethereum glyph (the diamond), drawn in currentColor so it fits any button or text color.
const ETH = `<svg class="eth" viewBox="0 0 256 417" aria-label="ETH" role="img"><path fill="currentColor" d="M128 0 125 9.5v275.7l3 2.8 128-75.6z" opacity=".6"/><path fill="currentColor" d="M128 0 0 212.3l128 75.7V154.2z"/><path fill="currentColor" d="M128 312.2l-1.6 1.9v98.2l1.6 4.6 128-180.3z" opacity=".6"/><path fill="currentColor" d="M128 416.9V312.2L0 236.6z"/><path fill="currentColor" d="M128 288l128-75.7-128-58.1z" opacity=".25"/><path fill="currentColor" d="M0 212.3 128 288V154.2z" opacity=".75"/></svg>`;
const eth = (wei, d = 4) => (wei == null ? "—" : Number(formatEther(wei)).toFixed(d).replace(/\.?0+$/, "") + " ETH");
function priceStr(p) {
  if (p == null) return "—";
  const v = st.ethUsd ? p * st.ethUsd : p;
  const pre = st.ethUsd ? "$" : "";
  if (v === 0) return pre + "0";
  if (v >= 0.01) return pre + v.toFixed(4);
  const s = v.toExponential(2).split("e-");
  const zeros = Number(s[1]) - 1;
  return `${pre}0.0<sub>${zeros}</sub>${s[0].replace(".", "").slice(0, 3)}`;
}
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
// Drawn size per avatar class, so each logo is fetched at the size it is shown.
const AV_PX = { av: 52, tav: 18, tmav: 20, king: 76, tok: 96, prev: 130 };
function avatar(t, cls = "av", px = AV_PX[cls] ?? 52) {
  const srcs = logoSources(t.logo || "", px);
  const ph = `<div class="${cls} ph" style="background:hsl(${hue(t.token || t.symbol)} 60% 35%)">${esc((t.symbol || "?")[0] || "?")}</div>`;
  if (!srcs.length) return ph;
  return `<img class="${cls}" src="${esc(srcs[0])}" alt="" width="${px}" height="${px}" decoding="async" loading="${px >= 76 ? "eager" : "lazy"}"
    referrerpolicy="no-referrer" onerror="logoFallback(this)" data-alt="${esc(JSON.stringify(srcs.slice(1)))}" data-ph="${esc(ph)}">`;
}
// Try the next source; when none are left, show the letter placeholder.
window.logoFallback = (img) => {
  const rest = JSON.parse(img.dataset.alt || "[]");
  if (rest.length) { img.dataset.alt = JSON.stringify(rest.slice(1)); img.src = rest[0]; }
  else img.outerHTML = img.dataset.ph;
};

// ── toasts ──────────────────────────────────────────────────────────────────
function toast(html, kind = "", ms = 6000) {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = html;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}
const errMsg = (e) => esc(e?.shortMessage || e?.message || String(e));
const txLink = (h) => (h ? ` · <a href="${scan("tx/" + h)}" target="_blank" rel="noopener">tx</a>` : "");

// ── wallet ──────────────────────────────────────────────────────────────────
const addrOf = (c) => (c ? (typeof c.account === "string" ? c.account : c.account.address) : null);
async function connect() {
  st.conn = await getWallet(S.wallet, chain, S.burner);
  await refreshWallet();
  return st.conn;
}
async function refreshWallet() {
  const a = addrOf(st.conn);
  if (!a) { $("#connectBtn").textContent = "Connect"; return; }
  const bal = await client.getBalance({ address: a }).catch(() => null);
  $("#connectBtn").innerHTML = `${S.wallet === "burner" ? "🔥 " : ""}${short(a)}${bal != null ? ` · <span class="muted">${Number(formatEther(bal)).toFixed(3)} ${ETH}</span>` : ""}`;
}
$("#connectBtn").onclick = () => connect().catch((e) => toast(errMsg(e), "err"));
async function ensureConn() { return st.conn || connect(); }

// ── data loading ────────────────────────────────────────────────────────────
function addToken(t, { fresh = false } = {}) {
  const k = t.token.toLowerCase();
  if (st.tokens.has(k)) return st.tokens.get(k);
  // Wall-clock launch time, so ages tick live and merge with Pons API items.
  if (t.createdAt == null && t.block != null && st.head) t.createdAt = Date.now() / 1000 - Number(st.head - t.block) * BLOCK_SEC;
  st.tokens.set(k, t);
  st.byCurve.set(t.curve.toLowerCase(), t);
  if (fresh) { st.order.unshift(t); st.freshUntil.set(k, Date.now() + 3000); }
  else st.order.push(t);
  return t;
}
const sortOrder = () => st.order.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

async function initialLoad() {
  const { head, launches } = await M.fetchRecentLaunches(client, { want: 240, maxChunks: 80 });
  st.head = head;
  st.tradeHead = head - 1200n;
  launches.forEach((t) => addToken(t));
  await Promise.all(st.order.map((t) => M.loadMeta(client, t).then(() => M.loadLive(client, t))));
  st.loaded = true;
  render();
  refreshGraduated();
}

let pollingLaunches = false;
async function pollLaunches() {
  if (!st.loaded || pollingLaunches) return;
  pollingLaunches = true;
  try {
    const { head, launches } = await M.fetchLaunchesSince(client, st.head + 1n);
    st.head = head;
    const fresh = launches.filter((t) => !st.tokens.has(t.token.toLowerCase()));
    if (fresh.length) {
      // Show as soon as name/logo are known; curve numbers follow on the next live tick.
      await Promise.all(fresh.map((t) => M.loadMeta(client, t)));
      fresh.forEach((t) => { t.phase = 0; t.progress = 0; });
      fresh.reverse().forEach((t) => addToken(t, { fresh: true }));
      sortOrder();
      if (route().page === "") renderDiscoverLists();
      updateStats();
      Promise.all(fresh.map((t) => M.loadLive(client, t))).then(() => route().page === "" && renderDiscoverLists());
    }
  } catch {} finally { pollingLaunches = false; }
}

async function pollLive() {
  if (!st.loaded) return;
  const r = route();
  const list = r.page === "token"
    ? [st.tokens.get(r.arg?.toLowerCase())].filter(Boolean)
    : [...new Set([...st.order.slice(0, 240), ...(st.grad || []), ...(st.trendingCurve || [])])];
  await Promise.all(list.map((t) => M.loadLive(client, t))).catch(() => {});
  if (r.page === "") renderDiscoverLists();
  if (r.page === "token") renderTokenLive();
}

async function refreshGraduated() {
  const grads = st.order.filter((t) => t.phase === 2).map((t) => t.token);
  if (!grads.length) return;
  const px = await M.dexPrices(grads);
  for (const [a, p] of Object.entries(px)) {
    const t = st.tokens.get(a);
    if (t) { t.dex = p; if (p.priceNative) { t.priceEth = p.priceNative; t.mcapEth = p.priceNative * (Number(t.supply) / 1e18); } }
  }
}

const buyEv = parseAbiItem("event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)");
const sellEv = parseAbiItem("event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)");
async function pollTrades() {
  if (!st.loaded) return;
  try {
    const head = await client.getBlockNumber();
    if (head <= st.tradeHead) return;
    const logs = await client.getLogs({ events: [buyEv, sellEv], fromBlock: st.tradeHead + 1n, toBlock: head });
    st.tradeHead = head;
    st.head = head > st.head ? head : st.head;
    const mapped = logs
      .map((l) => ({ l, t: st.byCurve.get(l.address.toLowerCase()) }))
      .filter((x) => x.t)
      .map(({ l, t }) => ({
        t, buy: l.eventName === "CurveBuy",
        ethAmt: l.eventName === "CurveBuy" ? l.args.quoteIn : l.args.quoteOut,
        who: l.args.buyer || l.args.seller, block: l.blockNumber, hash: l.transactionHash,
      }));
    if (mapped.length) {
      st.trades = [...mapped.reverse(), ...st.trades].slice(0, 40);
      renderTicker();
    }
  } catch {}
}

async function updatePrices() {
  const p = await M.ethUsd();
  if (p) { st.ethUsd = p; $("#ethPrice").innerHTML = `${ETH} $${p.toFixed(0)}`; }
}

// ── routing ─────────────────────────────────────────────────────────────────
// Clean URLs (/vamp, /profile, /token/0x…) via the History API. Vercel serves
// index.html for every path (vercel.json), Vite does the same in dev/preview.
function route() {
  const [, page = "", arg] = location.pathname.split("/");
  return { page, arg };
}
function go(path) {
  if (location.pathname !== path) history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => render());
// Old links like /#/token/0x… keep working.
if (location.hash.startsWith("#/")) history.replaceState(null, "", location.hash.slice(1));
// Same-tab internal links go through the router instead of reloading the page.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='/']");
  if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});
function render() {
  const r = route();
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === r.page));
  if (r.page === "vamp") return renderVamp(r.arg);
  if (r.page === "token") return renderToken(r.arg);
  if (r.page === "profile" || r.page === "me") return renderProfile(r.arg);
  return renderDiscover();
}

// ── ticker ──────────────────────────────────────────────────────────────────
function renderTicker() {
  const items = st.trades.map((x) => `
    <span class="trade" data-token="${x.t.token}">
      ${avatar(x.t, "tav")}<b class="${x.buy ? "up" : "down"}">${x.buy ? "BUY" : "SELL"}</b>
      ${esc(Number(formatEther(x.ethAmt)).toFixed(4))} ${ETH} <span class="muted">$${esc(x.t.symbol)}</span>
    </span>`).join("");
  $("#tickerTrack").innerHTML = items ? items + items : `<span class="muted trade">Waiting for live trades…</span>`;
}
$("#tickerTrack").addEventListener("click", (e) => {
  const el = e.target.closest("[data-token]");
  if (el) go(`/token/${el.dataset.token}`);
});

// ── discover ────────────────────────────────────────────────────────────────
function renderDiscover() {
  app.innerHTML = `
    <section class="hero">
      <div class="panel hero-main">
        <img src="/logo.svg" class="bg-logo" alt="">
        <h1>Vamp any memecoin on <em>Robinhood Chain</em>.</h1>
        <p>Paste a contract address and hit <kbd>Enter</kbd>. Name, ticker, logo, socials get cloned and launched on Pons in one transaction.</p>
        <input id="heroCA" class="big" placeholder="Paste CA or any link with a CA…" autocomplete="off" spellcheck="false">
        <div class="stats" id="stats"></div>
      </div>
      <div class="panel king" id="king"></div>
    </section>
    <section class="toolbar">
      <input id="search" placeholder="Search name, ticker or CA" value="${esc(st.filter)}">
      <span class="muted" style="margin-left:auto;font-size:12px">Live from Pons v2 factory · auto-refresh</span>
    </section>
    <section class="cols">
      <div class="panel col"><div class="col-head"><h2><span class="dot"></span> New launches</h2><span class="muted" id="cNew"></span></div><div class="col-body" id="colNew"></div></div>
      <div class="panel col"><div class="col-head"><h2>🔥 Graduating</h2><span class="muted" id="cGrad"></span></div><div class="col-body" id="colGrad"></div></div>
      <div class="panel col"><div class="col-head"><h2>🎓 Bonded</h2><span class="muted" id="cBond"></span></div><div class="col-body" id="colBond"></div></div>
    </section>`;
  $("#heroCA").addEventListener("paste", (e) => {
    const ca = extractCA(e.clipboardData?.getData("text"));
    if (ca) { e.preventDefault(); go(`/vamp/${ca}`); }
  });
  $("#heroCA").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const ca = extractCA(e.target.value);
    if (ca) go(`/vamp/${ca}`); else toast("No valid CA in that text.", "err");
  });
  $("#search").addEventListener("input", (e) => { st.filter = e.target.value; renderDiscoverLists(); });
  renderDiscoverLists();
  updateStats();
}

function updateStats() {
  const el = $("#stats");
  if (!el) return;
  const live = st.order.filter((t) => t.phase === 0);
  const last = st.order[0];
  el.innerHTML = `
    <div class="stat"><b>${st.order.length || "…"}</b><span>launches tracked</span></div>
    <div class="stat"><b>${live.length || "…"}</b><span>on the curve</span></div>
    <div class="stat"><b>${st.launchFee != null ? eth(st.launchFee) : "…"}</b><span>launch fee</span></div>
    <div class="stat"><b>${last ? ageOf(last) : "…"}</b><span>since last launch</span></div>`;
}

function matches(t) {
  const q = st.filter.trim().toLowerCase();
  if (!q) return true;
  return (t.name || "").toLowerCase().includes(q) || (t.symbol || "").toLowerCase().includes(q) || t.token.toLowerCase().includes(q);
}

// ── Pons-only boards ────────────────────────────────────────────────────────
// The home page only shows tokens launched by the Pons v2 factory that are still
// on their Pons bonding curve (ETH pair). Graduated tokens (trading on Uniswap),
// legacy v1 pools and anything from other launchpads are left out.
const isPonsCurve = (l) =>
  l && l.stage === "curve" && l.protocol === "v2" &&
  (l.factory || "").toLowerCase() === PONS_V2_FACTORY.toLowerCase() && !!l.curve &&
  (l.quote?.isNative ?? true);

/** Turn a Pons API launch into our token object (and register it so live refresh / quick buy work). */
function fromPons(l) {
  const k = l.address.toLowerCase();
  const t = st.tokens.get(k) || {
    token: l.address, curve: l.curve, deployer: l.deployer, block: 0n, phase: 0,
    supply: 10n ** 27n, threshold: BigInt(Math.round((l.thresholdQuote || 4.2) * 1e6)) * 10n ** 12n,
  };
  Object.assign(t, {
    name: t.name || l.name, symbol: t.symbol || l.symbol, logo: t.logo || l.artwork || "",
    description: t.description ?? l.description, socials: t.socials || l.socials || {},
    createdAt: l.createdAt, creatorTaxBps: t.creatorTaxBps ?? l.creatorTaxBps,
    volumeUsd: l.volumeUsd, tradeCount: l.tradeCount,
  });
  if (t.progress == null && l.progress != null) t.progress = l.progress;
  if (t.mcapEth == null && l.marketCapQuote) t.mcapEth = l.marketCapQuote;
  if (t.raised == null && l.raisedQuote != null) t.raised = BigInt(Math.round(l.raisedQuote * 1e6)) * 10n ** 12n;
  if (!st.tokens.has(k)) { st.tokens.set(k, t); st.byCurve.set(t.curve.toLowerCase(), t); }
  return t;
}

// Bonded = Pons v2 launches that completed their curve and now trade in their locked pool.
const isPonsBonded = (l) =>
  l && l.stage === "graduated" && l.protocol === "v2" &&
  (l.factory || "").toLowerCase() === PONS_V2_FACTORY.toLowerCase();

async function loadPonsBoards() {
  const [newest, grad, bonded, trending] = await Promise.all([
    M.ponsLaunches({ stage: "curve", sort: "newest" }).catch(() => null),
    M.ponsLaunches({ stage: "curve", sort: "progress" }).catch(() => null),
    M.ponsLaunches({ stage: "graduated", sort: "newest" }).catch(() => null),
    M.ponsTrending().catch(() => null),
  ]);
  // Newest from Pons fills any gap the on-chain feed has not caught yet.
  if (newest) {
    let added = false;
    for (const l of newest.filter(isPonsCurve)) {
      const known = st.tokens.has(l.address.toLowerCase());
      const t = fromPons(l);
      if (!st.order.includes(t)) { st.order.push(t); added = true; if (!known && st.loaded) st.freshUntil.set(l.address.toLowerCase(), Date.now() + 3000); }
    }
    if (added) sortOrder();
  }
  if (grad) st.grad = grad.filter(isPonsCurve).map(fromPons);
  if (bonded) st.bonded = bonded.filter(isPonsBonded).map((l) => Object.assign(fromPons(l), { phase: 2, progress: 1, graduatedAt: l.graduatedAt, mcapUsd: l.marketCapUsd, mcapEth: l.quote?.isNative ? l.marketCapQuote : null }))
    .sort((a, b) => (b.graduatedAt || 0) - (a.graduatedAt || 0));
  if (trending) st.trendingCurve = trending.filter((x) => isPonsCurve(x.launch)).map((x) => Object.assign(fromPons(x.launch), { trend: x, image: x.image }));
  st.boardsFailed = !newest && !grad && !bonded && !trending;
  if (route().page === "") renderDiscoverLists();
}

const fmtAge = (sec) => {
  const s = Math.max(0, Date.now() / 1000 - sec);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
// Ages carry their timestamp so a 1-second ticker can keep them live.
function ageOf(t) {
  if (t.createdAt) return `<span data-ts="${t.createdAt}">${fmtAge(t.createdAt)}</span>`;
  return ago(t.block);
}
setInterval(() => { for (const el of document.querySelectorAll("[data-ts]")) el.textContent = fmtAge(Number(el.dataset.ts)); }, 1000);

function card(t) {
  const fresh = (st.freshUntil.get(t.token.toLowerCase()) || 0) > Date.now();
  const bonded = t.phase === 2;
  const pct = bonded ? 100 : Math.round((t.progress || 0) * 100);
  return `
  <div class="card ${fresh ? "fresh" : ""} ${bonded ? "bonded" : ""}" data-token="${t.token}">
    ${avatar(t)}
    <div class="meta">
      <div class="t1"><b>${esc(t.name)}</b><span class="sym">$${esc(t.symbol)}</span></div>
      <div class="t2"><span class="mc">MC ${mcap(t)}</span>${bonded
        ? `<span class="tag grad">bonded ${t.graduatedAt ? `<span data-ts="${t.graduatedAt}">${fmtAge(t.graduatedAt)}</span>` : ""}</span>`
        : `<span>${ageOf(t)}</span><span>${pct}%</span>`}${t.creatorTaxBps ? `<span class="tag tax">tax ${t.creatorTaxBps / 100}%</span>` : ""}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="acts">
      ${bonded ? `<a class="btn sm green" href="/token/${t.token}">Trade</a>` : `<button class="btn sm green" data-qbuy="${t.token}">Buy ${esc(S.quickBuy)}</button>`}
      <button class="btn sm" data-vamp="${t.token}">🧛 Vamp</button>
    </div>
  </div>`;
}

function renderDiscoverLists() {
  if (!$("#colNew")) return;
  if (!st.loaded) {
    const sk = `<div class="skel"></div>`.repeat(6);
    $("#colNew").innerHTML = sk; $("#colGrad").innerHTML = sk; $("#colBond").innerHTML = sk;
    renderKing();
    return;
  }
  // Pons v2 tokens only: still on the Pons curve (New, Graduating) or bonded into their Pons pool.
  const onCurve = (t) => t.phase === 0 && matches(t);
  const fresh = st.order.filter(onCurve).slice(0, 60);
  const grad = (st.grad || []).filter(onCurve).sort((a, b) => b.progress - a.progress).slice(0, 60);
  const bonded = (st.bonded || []).filter(matches).slice(0, 60);
  const fill = (id, cid, arr, empty) => {
    // Keep scroll position inside the column while it refreshes.
    const el = $(id), top = el.scrollTop;
    el.innerHTML = arr.length ? arr.map(card).join("") : `<div class="empty">${empty}</div>`;
    el.scrollTop = top;
    $(cid).textContent = arr.length;
  };
  const wait = st.boardsFailed ? "Pons board is unavailable right now." : st.grad ? null : "Loading from Pons…";
  fill("#colNew", "#cNew", fresh, "No launches match.");
  fill("#colGrad", "#cGrad", grad, wait || "Nothing close to graduating.");
  fill("#colBond", "#cBond", bonded, wait || "No bonded tokens.");

  renderKing();
  updateStats();
}

// King of the curve, from Pons' own data: Pons trending tokens that are still on
// their Pons curve first, then the Pons board sorted by curve progress.
function renderKing() {
  const el = $("#king");
  if (!el) return;
  const seen = new Set();
  const list = [...(st.trendingCurve || []), ...(st.grad || [])]
    .filter((t) => t.phase === 0 && !seen.has(t.token.toLowerCase()) && seen.add(t.token.toLowerCase()));
  if (!list.length) {
    el.innerHTML = st.boardsFailed
      ? `<div class="label">👑 King of the curve</div><div class="empty">Pons data is unavailable right now.</div>`
      : `<div class="skel" style="height:100%"></div>`;
    return;
  }
  const [k, ...rest] = list;
  const why = k.trend ? "#1 trending on Pons" : "highest curve progress on Pons";
  const chg = k.trend?.change == null ? "" : `<span class="${k.trend.change >= 0 ? "up" : "down"}">${k.trend.change >= 0 ? "+" : ""}${(k.trend.change * 100).toFixed(1)}%</span>`;
  const pct = ((k.progress || 0) * 100).toFixed(1);
  el.dataset.token = k.token;
  el.innerHTML = `
    <div class="label">👑 King of the curve <span class="muted" style="letter-spacing:0;text-transform:none;font-weight:500">· ${why}</span></div>
    <div class="row">${avatar({ ...k, logo: k.image || k.logo }, "av", 76)}
      <div><div class="name">${esc(k.name)}</div><div class="muted">$${esc(k.symbol)} · ${ageOf(k)} old ${chg}</div></div></div>
    <div class="muted" style="display:flex;justify-content:space-between"><span>Bonding curve</span><b style="color:var(--text)">${pct}%</b></div>
    <div class="bar big"><i style="width:${pct}%"></i></div>
    <div class="kv" style="grid-template-columns:repeat(3,1fr)">
      <div><span>Market cap</span><b>${usd(k.mcapEth)}</b></div>
      <div><span>Volume</span><b>${compact(k.trend?.volumeUsd ?? k.volumeUsd, "$")}</b></div>
      <div><span>${k.trend ? "Traders" : "Trades"}</span><b>${k.trend?.traders ?? k.tradeCount ?? "—"}</b></div>
    </div>
    <div class="trend-mini">${rest.slice(0, 4).map((x, i) => `
      <div class="tm" data-token="${x.token}">
        <span class="muted">#${i + 2}</span>${avatar({ ...x, logo: x.image || x.logo }, "tmav")}
        <b>${esc(x.symbol)}</b><span class="muted">${Math.round((x.progress || 0) * 100)}%</span></div>`).join("")}
    </div>
    <div class="row">
      <button class="btn green" data-qbuy="${k.token}">Buy ${esc(S.quickBuy)} ${ETH}</button>
      <button class="btn" data-vamp="${k.token}">🧛 Vamp it</button>
    </div>`;
}

// One delegated click handler for cards / buttons anywhere.
app.addEventListener("click", (e) => {
  const q = e.target.closest("[data-qbuy]");
  if (q) { e.stopPropagation(); return quickBuy(q.dataset.qbuy, q); }
  const v = e.target.closest("[data-vamp]");
  if (v) { e.stopPropagation(); return go(`/vamp/${v.dataset.vamp}`); }
  const c = e.target.closest("[data-token]");
  if (c && !e.target.closest("a, button, input")) go(`/token/${c.dataset.token}`);
});

async function quickBuy(token, btn) {
  const t = st.tokens.get(token.toLowerCase());
  if (!t) return go(`/token/${token}`);
  btn && (btn.disabled = true);
  try {
    await ensureConn();
    const amount = parseEther(String(S.quickBuy || "0"));
    if (!amount) throw new Error("Set a quick-buy amount in Settings.");
    toast(`Buying ${S.quickBuy} ${ETH} of $${esc(t.symbol)}…`);
    const r = await M.buy({ client, wallet: st.conn.wallet, account: st.conn.account, curve: t.curve, quoteIn: amount, slippageBps: Math.round(S.slippage * 100) });
    toast(`✅ Bought ~${compact(Number(formatUnits(r.tokensOut, 18)))} $${esc(t.symbol)}${txLink(r.hash)}`, "ok", 9000);
    M.loadLive(client, t).then(() => route().page === "" && renderDiscoverLists());
    refreshWallet();
  } catch (e) {
    toast(`❌ ${errMsg(e)}${txLink(e.hash)}`, "err", 9000);
  } finally {
    btn && (btn.disabled = false);
  }
}

// ── token page ──────────────────────────────────────────────────────────────
let tradeSide = "buy";
async function renderToken(addr) {
  const key = addr?.toLowerCase();
  let t = st.tokens.get(key);
  app.innerHTML = `<div class="panel empty">Loading token…</div>`;
  if (!t) {
    try {
      const launched = await client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [addr] });
      if (!launched.exists) {
        app.innerHTML = `<div class="panel empty">Not a Pons v2 launch. <a class="btn primary" href="/vamp/${esc(addr)}" style="margin-left:8px">🧛 Vamp it instead</a></div>`;
        return;
      }
      t = { token: launched.token, curve: launched.curve, deployer: launched.deployer, threshold: launched.graduationThreshold, block: st.head };
      await M.loadMeta(client, t); await M.loadLive(client, t);
      addToken(t);
    } catch (e) {
      app.innerHTML = `<div class="panel empty">Could not load ${esc(short(addr))}: ${errMsg(e)}</div>`;
      return;
    }
  }
  const s = t.socials || {};
  const link = (u, label) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : "");
  app.innerHTML = `
  <section class="tok">
    <div style="display:grid;gap:22px">
      <div class="panel tok-head">
        ${avatar(t, "av", 96)}
        <div>
          <h1 class="name">${esc(t.name)} <span class="muted" style="font-size:16px">$${esc(t.symbol)}</span></h1>
          <div class="muted" style="margin-top:4px">${esc(t.description || "No description.")}</div>
          <div class="links">
            <a href="#" data-copy="${t.token}">📋 ${short(t.token)}</a>
            ${link(s.twitter, "𝕏 Twitter")}${link(s.telegram, "Telegram")}${link(s.discord, "Discord")}${link(s.website, "🌐 Website")}${link(s.farcaster, "Farcaster")}
            <a href="${scan("token/" + t.token)}" target="_blank" rel="noopener">Blockscout</a>
            <a href="https://dexscreener.com/robinhood/${t.token}" target="_blank" rel="noopener">DexScreener</a>
          </div>
        </div>
      </div>
      <div class="kv" id="tokKv"></div>
      <div class="panel section">
        <div style="display:flex;justify-content:space-between"><h2>Bonding curve</h2><b id="tokPct"></b></div>
        <div class="bar big"><i id="tokBar"></i></div>
        <div class="muted" id="tokGradNote" style="font-size:13px"></div>
      </div>
      <div class="panel section">
        <h2>Recent trades</h2>
        <div id="tokTrades"><div class="skel"></div></div>
      </div>
    </div>
    <aside class="panel trade-box" id="tradeBox"></aside>
  </section>`;
  renderTokenLive();
  renderTradeBox(t);
  loadTokenTrades(t);
}

function renderTokenLive() {
  const t = st.tokens.get(route().arg?.toLowerCase());
  if (!t || !$("#tokKv")) return;
  const pct = ((t.progress || 0) * 100).toFixed(1);
  $("#tokKv").innerHTML = `
    <div><span>Price</span><b>${priceStr(t.priceEth)}</b></div>
    <div><span>Market cap</span><b>${usd(t.mcapEth)}</b></div>
    <div><span>Raised</span><b>${eth(t.raised, 3)}</b></div>
    <div><span>Creator tax</span><b>${(t.creatorTaxBps || 0) / 100}%</b></div>`;
  $("#tokPct").textContent = pct + "%";
  $("#tokBar").style.width = pct + "%";
  $("#tokGradNote").innerHTML = t.phase === 2
    ? `Graduated — trading on Uniswap v4. <a href="https://dexscreener.com/robinhood/${t.token}" target="_blank" rel="noopener" style="color:var(--accent2)">Trade on DexScreener →</a>`
    : t.phase === 1 ? "Curve closed, pool being created."
    : `${eth(t.raised, 3)} of ${eth(t.threshold, 2)} raised. At 100% the curve graduates into a locked Uniswap v4 pool.`;
}

async function loadTokenTrades(t) {
  try {
    const head = await client.getBlockNumber();
    // The public RPC caps getLogs at 50k blocks, so walk back in chunks (~4h total).
    const ranges = [0n, 1n, 2n].map((i) => [head - 50_000n * (i + 1n) + 1n, head - 50_000n * i]).filter(([f]) => f > 0n);
    const parts = await Promise.all(ranges.map(([fromBlock, toBlock]) =>
      client.getLogs({ address: t.curve, events: [buyEv, sellEv], fromBlock, toBlock }).catch(() => [])));
    const logs = parts.reverse().flat();
    const rows = logs.slice(-40).reverse().map((l) => {
      const b = l.eventName === "CurveBuy";
      return `<tr>
        <td class="${b ? "up" : "down"}"><b>${b ? "Buy" : "Sell"}</b></td>
        <td>${Number(formatEther(b ? l.args.quoteIn : l.args.quoteOut)).toFixed(4)} ${ETH}</td>
        <td>${compact(Number(formatUnits(b ? l.args.tokensOut : l.args.tokensIn, 18)))}</td>
        <td class="mono"><a href="${scan("address/" + (l.args.buyer || l.args.seller))}" target="_blank" rel="noopener">${short(l.args.buyer || l.args.seller)}</a></td>
        <td class="muted">${ago(l.blockNumber)}</td>
        <td><a href="${scan("tx/" + l.transactionHash)}" target="_blank" rel="noopener" class="muted">↗</a></td>
      </tr>`;
    }).join("");
    $("#tokTrades").innerHTML = rows
      ? `<table class="trades"><thead><tr><th>Side</th><th>ETH</th><th>${esc(t.symbol)}</th><th>Wallet</th><th>Age</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">No curve trades in the last ~4 hours.</div>`;
  } catch (e) {
    $("#tokTrades") && ($("#tokTrades").innerHTML = `<div class="empty">Could not load trades: ${errMsg(e)}</div>`);
  }
}

function renderTradeBox(t) {
  const box = $("#tradeBox");
  if (!box) return;
  if (t.phase !== 0) {
    box.innerHTML = `<h2>Trade</h2><p class="muted">This token left the bonding curve.</p>
      <a class="btn primary" href="https://dexscreener.com/robinhood/${t.token}" target="_blank" rel="noopener">Trade on Uniswap →</a>
      <button class="btn" data-vamp="${t.token}">🧛 Vamp this token</button>`;
    return;
  }
  const isBuy = tradeSide === "buy";
  box.innerHTML = `
    <div class="tabs"><button class="buy ${isBuy ? "on" : ""}" data-side="buy">Buy</button><button class="sell ${!isBuy ? "on" : ""}" data-side="sell">Sell</button></div>
    <div class="amt"><input id="tradeAmt" type="number" min="0" step="any" placeholder="0.0"><span>${isBuy ? "ETH" : esc(t.symbol)}</span></div>
    <div class="presets">${isBuy
      ? ["0.005", "0.01", "0.05", "0.1", "0.5"].map((v) => `<button class="btn sm" data-preset="${v}">${v}</button>`).join("")
      : [25, 50, 75, 100].map((v) => `<button class="btn sm" data-pct="${v}">${v}%</button>`).join("")}</div>
    <div class="quote" id="tradeQuote"><span>Enter an amount to get a quote.</span></div>
    <button class="btn ${isBuy ? "green" : "primary"}" id="tradeGo">${isBuy ? "Buy" : "Sell"} $${esc(t.symbol)}</button>
    <div class="muted" style="font-size:12px">Slippage ${S.slippage}% · fee ${t.creatorTaxBps ? `1% + ${t.creatorTaxBps / 100}% creator tax` : "1%"}</div>
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <button class="btn" data-vamp="${t.token}">🧛 Vamp this token</button>
    <div class="muted" id="myBal" style="font-size:12px"></div>`;
  $$("[data-side]", box).forEach((b) => (b.onclick = () => { tradeSide = b.dataset.side; renderTradeBox(t); }));
  const amt = $("#tradeAmt");
  $$("[data-preset]", box).forEach((b) => (b.onclick = () => { amt.value = b.dataset.preset; requote(); }));
  $$("[data-pct]", box).forEach((b) => (b.onclick = async () => {
    const a = addrOf(st.conn) || addrOf(await ensureConn().catch(() => null));
    if (!a) return;
    const bal = await M.tokenBalance(client, t.token, a);
    amt.value = formatUnits((bal * BigInt(b.dataset.pct)) / 100n, 18);
    requote();
  }));
  let qt;
  const requote = () => {
    clearTimeout(qt);
    qt = setTimeout(async () => {
      const v = amt.value;
      if (!v || Number(v) <= 0) { $("#tradeQuote").innerHTML = `<span>Enter an amount to get a quote.</span>`; return; }
      try {
        if (tradeSide === "buy") {
          const q = await M.quoteBuy(client, t.curve, parseEther(v), addrOf(st.conn) || "0x000000000000000000000000000000000000dEaD");
          $("#tradeQuote").innerHTML = `<span>You get ≈ <b>${compact(Number(formatUnits(q.tokensOut, 18)))} $${esc(t.symbol)}</b></span>${q.snipeBps ? `<span class="warn">Snipe tax active: ${Number(q.snipeBps) / 100}%</span>` : ""}`;
        } else {
          const q = await M.quoteSell(client, t.curve, parseUnits(v, 18));
          $("#tradeQuote").innerHTML = `<span>You get ≈ <b>${Number(formatEther(q.quoteOut)).toFixed(5)} ETH</b></span>`;
        }
      } catch (e) { $("#tradeQuote").innerHTML = `<span class="down">${errMsg(e)}</span>`; }
    }, 250);
  };
  amt.oninput = requote;
  $("#tradeGo").onclick = async (ev) => {
    const btn = ev.currentTarget;
    const v = amt.value;
    if (!v || Number(v) <= 0) return toast("Enter an amount.", "err");
    btn.disabled = true;
    try {
      await ensureConn();
      const common = { client, wallet: st.conn.wallet, account: st.conn.account, curve: t.curve, slippageBps: Math.round(S.slippage * 100) };
      const r = tradeSide === "buy"
        ? await M.buy({ ...common, quoteIn: parseEther(v) })
        : await M.sell({ ...common, token: t.token, tokensIn: parseUnits(v, 18) });
      toast(`✅ ${tradeSide === "buy" ? "Bought" : "Sold"} $${esc(t.symbol)}${txLink(r.hash)}`, "ok", 9000);
      await M.loadLive(client, t); renderTokenLive(); loadTokenTrades(t); refreshWallet(); showBal(t);
    } catch (e) {
      toast(`❌ ${errMsg(e)}${txLink(e.hash)}`, "err", 9000);
    } finally { btn.disabled = false; }
  };
  showBal(t);
}
async function showBal(t) {
  const a = addrOf(st.conn);
  if (!a || !$("#myBal")) return;
  const bal = await M.tokenBalance(client, t.token, a).catch(() => null);
  if (bal != null && $("#myBal")) $("#myBal").textContent = `You hold ${compact(Number(formatUnits(bal, 18)))} $${t.symbol}`;
}

// ── vamp page ───────────────────────────────────────────────────────────────
function renderVamp(prefill) {
  app.innerHTML = `
  <section class="vamp">
    <div class="panel vamp-box">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="font-size:20px">🧛 Vamp mode</h2>
        <label class="switch"><input type="checkbox" id="insta" ${S.insta ? "checked" : ""}><i></i><span>Insta-vamp <span class="muted">(launch on paste)</span></span></label>
      </div>
      <input id="ca" class="big" placeholder="Paste CA (or any link with a CA) → Enter" autocomplete="off" spellcheck="false">
      <div id="preview" class="preview hidden">
        <div id="pAv"></div>
        <div class="fields">
          <div class="row"><label>Name <input id="pName"></label><label class="sym">Ticker <input id="pSymbol"></label></div>
          <label>Logo URL <input id="pLogoUrl"></label>
          <label>Description <textarea id="pDesc" rows="2"></textarea></label>
          <div class="row"><label>𝕏 <input id="sTwitter"></label><label>Telegram <input id="sTelegram"></label><label>Website <input id="sWebsite"></label></div>
          <div class="row" style="align-items:center;justify-content:space-between">
            <span id="pSource" class="tag" style="flex:0 0 auto"></span>
            <button id="vampBtn" class="btn primary" style="flex:0 0 auto">VAMP ⏎</button>
          </div>
        </div>
      </div>
      <div id="status" class="status"></div>
    </div>
    <aside style="display:grid;gap:22px">
      <div class="panel section">
        <h2>How it works</h2>
        <div class="steps">
          <div><span><b>Paste a CA</b> from any Robinhood Chain token: Pons, Pools, Noxa or plain ERC-20.</span></div>
          <div><span><b>Check the clone.</b> Name, ticker, logo and socials are filled in; edit anything.</span></div>
          <div><span>Press <kbd>Enter</kbd>. It launches on Pons v2${S.devBuy && Number(S.devBuy) > 0 ? ` with a ${esc(S.devBuy)} ${ETH} dev buy` : ""}.</span></div>
        </div>
        <button class="btn ghost" id="openSettings2">⚙ Vamp settings</button>
      </div>
      <div class="panel section">
        <h2>Your vamps</h2>
        <div class="list" id="vampHist"></div>
      </div>
    </aside>
  </section>`;
  $("#openSettings2").onclick = openSettings;
  $("#insta").onchange = (e) => { S.insta = e.target.checked; save("ponsvamp.settings", S); };
  const ca = $("#ca");
  ca.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") || "";
    e.preventDefault();
    ca.value = extractCA(text) || text.trim();
    loadCA(text, { autoLaunch: S.insta });
  });
  ca.addEventListener("input", () => { if (extractCA(ca.value)) loadCA(ca.value); });
  $("#pLogoUrl").oninput = () => { $("#pAv").innerHTML = avatar({ logo: $("#pLogoUrl").value, symbol: $("#pSymbol").value }, "av", 130); };
  $("#vampBtn").onclick = vamp;
  renderVampHistory();
  st.vamp = null;
  if (prefill) { ca.value = prefill; loadCA(prefill, { autoLaunch: S.insta }); }
  ca.focus();
}

function vstatus(msg, kind = "") { const el = $("#status"); if (el) { el.className = "status " + kind; el.innerHTML = msg; } }

let loadSeq = 0;
async function loadCA(raw, { autoLaunch = false } = {}) {
  const ca = extractCA(raw);
  if (!ca) { st.vamp = null; $("#preview")?.classList.add("hidden"); if (raw?.trim()) vstatus("No valid CA found in that text.", "err"); return; }
  if (st.vamp?.ca === ca) { if (autoLaunch) vamp(); return; }
  const seq = ++loadSeq;
  vstatus(`Reading ${short(ca)}…`);
  try {
    const m = await fetchTokenMeta(client, ca);
    if (seq !== loadSeq || !$("#preview")) return;
    st.vamp = m;
    $("#pName").value = m.name;
    $("#pSymbol").value = (S.prefix + m.symbol + S.suffix).trim();
    $("#pLogoUrl").value = m.logo;
    $("#pAv").innerHTML = avatar({ logo: m.logo, symbol: m.symbol, token: ca }, "av", 130);
    $("#pDesc").value = S.copyDesc ? m.description : "";
    $("#sTwitter").value = S.copySocials ? m.socials.twitter : "";
    $("#sTelegram").value = S.copySocials ? m.socials.telegram : "";
    $("#sWebsite").value = S.copySocials ? m.socials.website : "";
    $("#pSource").textContent = `source: ${m.source} · ${short(m.ca)}`;
    $("#preview").classList.remove("hidden");
    vstatus(`Loaded <b>${esc(m.name)}</b> ($${esc(m.symbol)}). Press Enter to vamp.`, "ok");
    if (autoLaunch) vamp();
  } catch (e) {
    if (seq !== loadSeq) return;
    st.vamp = null;
    $("#preview")?.classList.add("hidden");
    vstatus(`Could not read ${short(ca)} on Robinhood Chain: ${errMsg(e)}`, "err");
  }
}

let vampBusy = false;
async function vamp() {
  if (vampBusy || !st.vamp || !$("#pName")) return;
  const src = st.vamp;
  const meta = {
    ...src,
    name: $("#pName").value.trim(),
    symbol: $("#pSymbol").value.trim(),
    logo: $("#pLogoUrl").value.trim(),
    description: $("#pDesc").value.trim(),
    socials: {
      ...(S.copySocials ? src.socials : { discord: "", farcaster: "" }),
      twitter: $("#sTwitter").value.trim(),
      telegram: $("#sTelegram").value.trim(),
      website: $("#sWebsite").value.trim(),
    },
  };
  if (!meta.name || !meta.symbol) return vstatus("Name and ticker are required.", "err");
  vampBusy = true;
  $("#vampBtn").disabled = true;
  try {
    await ensureConn();
    const devBuyWei = parseEther(String(S.devBuy || "0"));
    vstatus(`Vamping <b>${esc(meta.name)}</b> ($${esc(meta.symbol)})${devBuyWei ? ` + ${esc(S.devBuy)} ${ETH} dev buy` : ""}… confirm in wallet`);
    const res = await launchVamp({ client, wallet: st.conn.wallet, account: st.conn.account, meta, opts: { creatorTaxBps: S.tax, buyback: S.buyback, devBuyWei } });
    vampHistory.unshift({ ...res, name: meta.name, symbol: meta.symbol, logo: meta.logo, from: src.ca, at: Date.now() });
    vampHistory = vampHistory.slice(0, 100);
    save("ponsvamp.history", vampHistory);
    vstatus(`✅ Launched <b>$${esc(meta.symbol)}</b> → <a href="/token/${res.token}" style="color:var(--accent2)">${short(res.token)}</a>${txLink(res.hash)}`, "ok");
    toast(`🧛 $${esc(meta.symbol)} is live${txLink(res.hash)}`, "ok", 9000);
    renderVampHistory();
    $("#ca").value = ""; st.vamp = null; $("#preview").classList.add("hidden"); $("#ca").focus();
    refreshWallet();
    pollLaunches();
  } catch (e) {
    vstatus(`❌ ${errMsg(e)}${txLink(e.hash)}`, "err");
  } finally {
    vampBusy = false;
    $("#vampBtn") && ($("#vampBtn").disabled = false);
  }
}

function renderVampHistory() {
  const el = $("#vampHist");
  if (!el) return;
  el.innerHTML = vampHistory.length ? vampHistory.slice(0, 20).map((h) => `
    <div class="item">
      ${avatar({ logo: h.logo, symbol: h.symbol, token: h.token })}
      <div style="flex:1;min-width:0"><b>$${esc(h.symbol)}</b> <span class="muted">${esc(h.name)}</span><div class="muted mono" style="font-size:11px">from ${short(h.from)}</div></div>
      ${h.token ? `<a class="btn sm" href="/token/${h.token}">Open</a>` : ""}
    </div>`).join("") : `<div class="empty">Nothing vamped yet.</div>`;
}

// ── profile (creator fees, launches, holdings) ──────────────────────────────
const identicon = (a) => {
  const h = hue(a.toLowerCase());
  return `background:conic-gradient(from ${h}deg, hsl(${h} 75% 55%), hsl(${(h + 120) % 360} 70% 45%), hsl(${(h + 240) % 360} 75% 55%), hsl(${h} 75% 55%))`;
};

async function renderProfile(arg) {
  const me = addrOf(st.conn);
  const a = arg && /^0x[a-fA-F0-9]{40}$/.test(arg) ? arg : me;
  if (!a) {
    app.innerHTML = `<div class="panel empty" style="padding:60px">
      <div class="pf-av" style="margin:0 auto 14px;background:var(--panel2)"></div>
      <h2 style="justify-content:center;margin-bottom:10px">Connect to open your profile</h2>
      <p class="muted">Claim creator fees from your Pons launches, see your launches and holdings.</p>
      <button class="btn primary" id="pfConnect">Connect wallet</button></div>`;
    $("#pfConnect").onclick = () => connect().then(() => renderProfile()).catch((e) => toast(errMsg(e), "err"));
    return;
  }
  const own = me && me.toLowerCase() === a.toLowerCase();
  app.innerHTML = `
  <section class="panel pf-head">
    <div class="pf-av" style="${identicon(a)}"></div>
    <div style="min-width:0">
      <div class="muted" style="font-size:12px">${own ? "Your profile" : "Profile"}</div>
      <h1 class="mono pf-addr">${short(a)}</h1>
      <div class="links">
        <a href="#" data-copy="${a}">📋 Copy address</a>
        <a href="${scan("address/" + a)}" target="_blank" rel="noopener">Blockscout ↗</a>
        <a href="#" id="pfShare">🔗 Share profile</a>
      </div>
    </div>
    <div class="pf-bal"><span class="muted">Balance</span><b id="pfBal">…</b></div>
  </section>
  <section class="pf">
    <div style="display:grid;gap:22px;align-content:start">
      <div class="panel section fee-card">
        <div style="display:flex;justify-content:space-between;align-items:center"><h2>💰 Creator fees</h2><button class="btn sm ghost" id="pfRefresh">↻</button></div>
        <span class="muted">Ready to claim</span>
        <div class="big-num" id="pfFees">…</div>
        <div class="muted" id="pfFeesUsd" style="margin-top:-8px"></div>
        ${own ? `<button class="btn primary" id="pfClaim" disabled>Claim fees</button>` : `<div class="muted" style="font-size:12px">Only the owner of this wallet can claim.</div>`}
        <div class="muted" style="font-size:12px">Every trade on a token you launched on Pons pays you a creator fee (plus any creator tax). Pons keeps it in its fee escrow until you claim; it is sent to this wallet in ETH.</div>
      </div>
      <div class="panel section">
        <h2>Stats</h2>
        <div class="kv" style="grid-template-columns:1fr 1fr">
          <div><span>Launches</span><b id="pfNLaunch">…</b></div>
          <div><span>On curve</span><b id="pfNLive">…</b></div>
          <div><span>Holdings</span><b id="pfNHold">…</b></div>
          <div><span>Vamps here</span><b>${own ? vampHistory.length : "—"}</b></div>
        </div>
      </div>
    </div>
    <div style="display:grid;gap:22px;align-content:start">
      <div class="panel section"><h2>🚀 Launches</h2><div class="list" id="pfLaunch"><div class="skel"></div></div></div>
      <div class="panel section"><h2>👜 Holdings</h2><div class="list" id="pfHold"><div class="skel"></div></div></div>
    </div>
  </section>`;
  $("#pfShare").onclick = (e) => {
    e.preventDefault();
    const url = `${location.origin}/profile/${a}`;
    navigator.clipboard?.writeText(url);
    toast("Profile link copied", "ok", 2500);
  };
  client.getBalance({ address: a }).then((b) => $("#pfBal") && ($("#pfBal").textContent = eth(b, 4))).catch(() => {});

  const loadFees = () => M.claimable(client, a).then((f) => {
    if (!$("#pfFees")) return;
    $("#pfFees").textContent = eth(f, 6);
    $("#pfFeesUsd").textContent = st.ethUsd ? `≈ $${(Number(formatEther(f)) * st.ethUsd).toFixed(2)}` : "";
    const btn = $("#pfClaim");
    if (!btn) return;
    btn.disabled = !f;
    btn.textContent = f ? `Claim ${eth(f, 6)}` : "Nothing to claim yet";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Confirm in wallet…";
      try {
        const h = await M.claimFees({ client, wallet: st.conn.wallet, account: st.conn.account });
        toast(`✅ Claimed ${eth(f, 6)}${txLink(h)}`, "ok", 9000);
        refreshWallet();
        renderProfile(arg);
      } catch (e) {
        toast(`❌ ${errMsg(e)}${txLink(e.hash)}`, "err", 9000);
        btn.disabled = false;
        btn.textContent = `Claim ${eth(f, 6)}`;
      }
    };
  }).catch(() => $("#pfFees") && ($("#pfFees").textContent = "—"));
  loadFees();
  $("#pfRefresh").onclick = loadFees;

  // launches by this wallet (deployer is an indexed topic, so this is one cheap scan)
  M.fetchRecentLaunches(client, { want: 50, maxChunks: 320, deployer: a }).then(async ({ launches }) => {
    const list = launches.map((t) => addToken(t));
    await Promise.all(list.map((t) => (t.name ? M.loadLive(client, t) : M.loadMeta(client, t).then(() => M.loadLive(client, t)))));
    if (!$("#pfLaunch")) return;
    $("#pfNLaunch").textContent = list.length;
    $("#pfNLive").textContent = list.filter((t) => t.phase === 0).length;
    $("#pfLaunch").innerHTML = list.length ? list.map((t) => row(t)).join("") : `<div class="empty">No Pons v2 launches from this wallet in recent history. <a href="/vamp" style="color:var(--accent2)">Vamp one →</a></div>`;
  }).catch((e) => $("#pfLaunch") && ($("#pfLaunch").innerHTML = `<div class="empty">${errMsg(e)}</div>`));

  // holdings among every token we know about
  const known = [...st.tokens.values()];
  const bals = await Promise.all(known.map((t) => M.tokenBalance(client, t.token, a).catch(() => 0n)));
  const held = known.map((t, i) => ({ t, bal: bals[i] })).filter((x) => x.bal > 0n)
    .map((x) => ({ ...x, val: (x.t.priceEth || 0) * Number(formatUnits(x.bal, 18)) }))
    .sort((p, q) => q.val - p.val);
  $("#pfNHold") && ($("#pfNHold").textContent = held.length);
  $("#pfHold") && ($("#pfHold").innerHTML = held.length
    ? held.map(({ t, bal, val }) => row(t, `${compact(Number(formatUnits(bal, 18)))} · ${usd(val)}`)).join("")
    : `<div class="empty">No balances in tracked Pons tokens.</div>`);
}
function row(t, extra) {
  return `<div class="item" data-token="${t.token}" style="cursor:pointer">
    ${avatar(t)}
    <div style="flex:1;min-width:0"><b>${esc(t.name)}</b> <span class="muted">$${esc(t.symbol)}</span>
      <div class="muted" style="font-size:12px">${extra ?? `MC ${mcap(t)} · ${Math.round((t.progress || 0) * 100)}%`}</div></div>
    <a class="btn sm" href="/token/${t.token}">Trade</a>
  </div>`;
}

// ── global paste / quick box ────────────────────────────────────────────────
$("#quickCA").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const ca = extractCA(e.target.value);
  if (!ca) return toast("No valid CA in that text.", "err");
  e.target.value = "";
  go(`/vamp/${ca}`);
});
$("#quickCA").addEventListener("paste", (e) => {
  const ca = extractCA(e.clipboardData?.getData("text"));
  if (!ca) return;
  e.preventDefault();
  e.target.value = "";
  go(`/vamp/${ca}`);
});
// Ctrl/Cmd+V anywhere (outside inputs) → vamp that CA
document.addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea")) return;
  const ca = extractCA(e.clipboardData?.getData("text"));
  if (!ca) return;
  e.preventDefault();
  if (route().page === "vamp" && $("#ca")) { $("#ca").value = ca; $("#ca").focus(); loadCA(ca, { autoLaunch: S.insta }); }
  else go(`/vamp/${ca}`);
});
// Enter = vamp on the vamp page
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || $("#settings").open || route().page !== "vamp") return;
  if (e.target.id === "pDesc" || e.target.id === "quickCA") return;
  e.preventDefault();
  const v = $("#ca")?.value;
  if (st.vamp && extractCA(v) === st.vamp.ca) vamp();
  else if (v) loadCA(v, { autoLaunch: true });
});
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (!c) return;
  e.preventDefault();
  navigator.clipboard?.writeText(c.dataset.copy);
  toast(`Copied ${short(c.dataset.copy)}`, "ok", 2000);
});

// ── settings ────────────────────────────────────────────────────────────────
function openSettings() {
  const f = (id, v) => ($(id).value = v);
  f("#optWallet", S.wallet); f("#optBurner", S.burner); f("#optQuickBuy", S.quickBuy); f("#optSlippage", S.slippage);
  f("#optDevBuy", S.devBuy); f("#optTax", S.tax); f("#optPrefix", S.prefix); f("#optSuffix", S.suffix); f("#optRpc", S.rpc);
  $("#optBuyback").checked = S.buyback; $("#optCopySocials").checked = S.copySocials; $("#optCopyDesc").checked = S.copyDesc;
  $("#burnerRow").style.display = S.wallet === "burner" ? "" : "none";
  $("#settings").showModal();
}
$("#optWallet").onchange = () => { $("#burnerRow").style.display = $("#optWallet").value === "burner" ? "" : "none"; };
$("#settingsBtn").onclick = openSettings;
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  let burner = $("#optBurner").value.trim();
  if (burner && !burner.startsWith("0x")) burner = "0x" + burner;
  const rpc = $("#optRpc").value.trim() || DEFAULT_RPC;
  const walletChanged = $("#optWallet").value !== S.wallet || burner !== S.burner;
  const rpcChanged = rpc !== S.rpc;
  S = {
    ...S,
    wallet: $("#optWallet").value, burner,
    quickBuy: $("#optQuickBuy").value || "0.01",
    slippage: Math.min(50, Math.max(0.1, Number($("#optSlippage").value) || 10)),
    devBuy: $("#optDevBuy").value || "0",
    tax: Math.max(0, Math.min(Number($("#optTax").value) || 0, Number($("#maxTax").textContent) || 1000)),
    buyback: $("#optBuyback").checked, copySocials: $("#optCopySocials").checked, copyDesc: $("#optCopyDesc").checked,
    prefix: $("#optPrefix").value, suffix: $("#optSuffix").value, rpc,
  };
  save("ponsvamp.settings", S);
  if (rpcChanged) { chain = makeChain(S.rpc); client = makePublicClient(chain); }
  if (walletChanged || rpcChanged) { st.conn = null; $("#connectBtn").textContent = "Connect"; }
  render();
});

// ── boot ────────────────────────────────────────────────────────────────────
render();
renderTicker();
Promise.all([
  client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "launchFee" }),
  client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
]).then(([fee, maxTax]) => { st.launchFee = fee; $("#maxTax").textContent = String(maxTax); updateStats(); }).catch(() => {});
updatePrices().then(() => route().page === "" && renderDiscoverLists());
initialLoad().catch((e) => toast(`Could not load launches: ${errMsg(e)}`, "err", 12000));
loadPonsBoards();
setInterval(loadPonsBoards, 8000);
setInterval(pollLaunches, 2500);
setInterval(pollTrades, 5000);
setInterval(pollLive, 10000);
setInterval(updatePrices, 60000);
setInterval(refreshGraduated, 60000);
if (S.wallet === "burner" && S.burner) connect().catch(() => {});
else if (window.ethereum?.selectedAddress) connect().catch(() => {});
