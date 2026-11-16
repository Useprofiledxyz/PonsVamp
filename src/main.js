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
  $("#connectBtn").innerHTML = `${S.wallet === "burner" ? "🔥 " : ""}${short(a)}${bal != null ? ` · <span class="muted">${Number(formatEther(bal)).toFixed(3)} Ξ</span>` : ""}`;
}
$("#connectBtn").onclick = () => connect().catch((e) => toast(errMsg(e), "err"));
async function ensureConn() { return st.conn || connect(); }

// ── data loading ────────────────────────────────────────────────────────────
function addToken(t, { fresh = false } = {}) {
  const k = t.token.toLowerCase();
  if (st.tokens.has(k)) return st.tokens.get(k);
  st.tokens.set(k, t);
  st.byCurve.set(t.curve.toLowerCase(), t);
  if (fresh) { st.order.unshift(t); st.freshUntil.set(k, Date.now() + 2500); }
  else st.order.push(t);
  return t;
}

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

async function pollLaunches() {
  if (!st.loaded) return;
  try {
    const { head, launches } = await M.fetchLaunchesSince(client, st.head + 1n);
    st.head = head;
    const fresh = launches.filter((t) => !st.tokens.has(t.token.toLowerCase()));
    if (fresh.length) {
      await Promise.all(fresh.map((t) => M.loadMeta(client, t).then(() => M.loadLive(client, t))));
      fresh.reverse().forEach((t) => addToken(t, { fresh: true }));
      if (route().page === "") renderDiscoverLists();
      updateStats();
    }
  } catch {}
}

async function pollLive() {
  if (!st.loaded) return;
  const r = route();
  const list = r.page === "token" ? [st.tokens.get(r.arg?.toLowerCase())].filter(Boolean) : st.order.slice(0, 240);
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
  if (p) { st.ethUsd = p; $("#ethPrice").textContent = `Ξ $${p.toFixed(0)}`; }
}

// ── routing ─────────────────────────────────────────────────────────────────
function route() {
  const [, page = "", arg] = location.hash.replace(/^#/, "").split("/");
  return { page, arg };
}
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
function render() {
  const r = route();
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === r.page));
  if (r.page === "vamp") return renderVamp(r.arg);
  if (r.page === "token") return renderToken(r.arg);
  if (r.page === "me") return renderPortfolio();
  return renderDiscover();
}

// ── ticker ──────────────────────────────────────────────────────────────────
function renderTicker() {
  const items = st.trades.map((x) => `
    <span class="trade" data-token="${x.t.token}">
      ${avatar(x.t, "tav")}<b class="${x.buy ? "up" : "down"}">${x.buy ? "BUY" : "SELL"}</b>
      ${esc(Number(formatEther(x.ethAmt)).toFixed(4))} Ξ <span class="muted">$${esc(x.t.symbol)}</span>
    </span>`).join("");
  $("#tickerTrack").innerHTML = items ? items + items : `<span class="muted trade">Waiting for live trades…</span>`;
}
$("#tickerTrack").addEventListener("click", (e) => {
  const el = e.target.closest("[data-token]");
  if (el) go(`#/token/${el.dataset.token}`);
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
      <div class="panel col"><div class="col-head"><h2>🔥 Heating up</h2><span class="muted" id="cHot"></span></div><div class="col-body" id="colHot"></div></div>
      <div class="panel col"><div class="col-head"><h2>🎓 Graduating</h2><span class="muted" id="cGrad"></span></div><div class="col-body" id="colGrad"></div></div>
    </section>`;
  $("#heroCA").addEventListener("paste", (e) => {
    const ca = extractCA(e.clipboardData?.getData("text"));
    if (ca) { e.preventDefault(); go(`#/vamp/${ca}`); }
  });
  $("#heroCA").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const ca = extractCA(e.target.value);
    if (ca) go(`#/vamp/${ca}`); else toast("No valid CA in that text.", "err");
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
    <div class="stat"><b>${last ? ago(last.block) : "…"}</b><span>since last launch</span></div>`;
}

function matches(t) {
  const q = st.filter.trim().toLowerCase();
  if (!q) return true;
  return (t.name || "").toLowerCase().includes(q) || (t.symbol || "").toLowerCase().includes(q) || t.token.toLowerCase().includes(q);
}

function card(t) {
  const fresh = (st.freshUntil.get(t.token.toLowerCase()) || 0) > Date.now();
  const pct = Math.round((t.progress || 0) * 100);
  return `
  <div class="card ${fresh ? "fresh" : ""}" data-token="${t.token}">
    ${avatar(t)}
    <div class="meta">
      <div class="t1"><b>${esc(t.name)}</b><span class="sym">$${esc(t.symbol)}</span></div>
      <div class="t2"><span class="mc">MC ${usd(t.mcapEth)}</span><span>${ago(t.block)}</span><span>${t.phase === 2 ? `<span class="tag grad">graduated</span>` : pct + "%"}</span>${t.creatorTaxBps ? `<span class="tag tax">tax ${t.creatorTaxBps / 100}%</span>` : ""}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="acts">
      ${t.phase === 0 ? `<button class="btn sm green" data-qbuy="${t.token}">Buy ${esc(S.quickBuy)}</button>` : ""}
      <button class="btn sm" data-vamp="${t.token}">🧛 Vamp</button>
    </div>
  </div>`;
}

function renderDiscoverLists() {
  if (!$("#colNew")) return;
  if (!st.loaded) {
    const sk = `<div class="skel"></div>`.repeat(6);
    $("#colNew").innerHTML = sk; $("#colHot").innerHTML = sk; $("#colGrad").innerHTML = sk;
    renderKing();
    return;
  }
  const all = st.order.filter(matches);
  const fresh = all.slice(0, 60);
  const hot = all.filter((t) => t.phase === 0 && t.progress >= 0.03 && t.progress < 0.35).sort((a, b) => b.progress - a.progress).slice(0, 60);
  const grad = all.filter((t) => t.progress >= 0.35 || t.phase >= 1).sort((a, b) => (b.phase - a.phase) || (b.progress - a.progress)).slice(0, 60);
  const fill = (id, cid, arr, empty) => {
    $(id).innerHTML = arr.length ? arr.map(card).join("") : `<div class="empty">${empty}</div>`;
    $(cid).textContent = arr.length;
  };
  fill("#colNew", "#cNew", fresh, "No launches match.");
  fill("#colHot", "#cHot", hot, "Nothing heating up yet.");
  fill("#colGrad", "#cGrad", grad, "Nothing past 35% yet.");

  renderKing();
  updateStats();
}

// King = #1 on Pons' own trending list (ponsfamily.com/api/launches/trending).
function renderKing() {
  const el = $("#king");
  if (!el) return;
  const list = st.trending || [];
  if (!list.length) {
    el.innerHTML = st.trendingFailed
      ? `<div class="label">👑 King of Pons</div><div class="empty">Pons trending is unavailable right now.</div>`
      : `<div class="skel" style="height:100%"></div>`;
    return;
  }
  const [k, ...rest] = list;
  const L = k.launch;
  const chg = k.change == null ? "" : `<span class="${k.change >= 0 ? "up" : "down"}">${k.change >= 0 ? "+" : ""}${(k.change * 100).toFixed(1)}%</span>`;
  const bonding = L.stage !== "graduated" && L.progress != null;
  const pct = bonding ? (L.progress * (L.progress <= 1 ? 100 : 1)).toFixed(1) : null;
  el.dataset.token = L.address;
  el.innerHTML = `
    <div class="label">👑 King of Pons <span class="muted" style="letter-spacing:0;text-transform:none;font-weight:500">· #1 trending on Pons</span></div>
    <div class="row">${avatar({ logo: k.image || L.artwork, symbol: L.symbol, token: L.address }, "av", 76)}
      <div><div class="name">${esc(L.name)}</div><div class="muted">$${esc(L.symbol)} · ${esc(L.stage)} ${chg}</div></div></div>
    ${bonding ? `<div class="muted" style="display:flex;justify-content:space-between"><span>Bonding curve</span><b style="color:var(--text)">${pct}%</b></div><div class="bar big"><i style="width:${pct}%"></i></div>` : ""}
    <div class="kv" style="grid-template-columns:repeat(3,1fr)">
      <div><span>Market cap</span><b>${compact(L.marketCapUsd, "$")}</b></div>
      <div><span>Volume</span><b>${compact(k.volumeUsd, "$")}</b></div>
      <div><span>Traders</span><b>${k.traders ?? "—"}</b></div>
    </div>
    <div class="trend-mini">${rest.slice(0, 4).map((x, i) => `
      <div class="tm" data-token="${x.launch.address}">
        <span class="muted">#${i + 2}</span>${avatar({ logo: x.image || x.launch.artwork, symbol: x.launch.symbol, token: x.launch.address }, "tmav")}
        <b>${esc(x.launch.symbol)}</b><span class="muted">${compact(x.launch.marketCapUsd, "$")}</span></div>`).join("")}
    </div>
    <div class="row">
      ${bonding && L.curve ? `<button class="btn green" data-qbuy="${L.address}">Buy ${esc(S.quickBuy)} Ξ</button>` : `<a class="btn green" href="#/token/${L.address}" style="text-align:center">Trade</a>`}
      <button class="btn" data-vamp="${L.address}">🧛 Vamp it</button>
    </div>`;
}

async function loadTrending() {
  try {
    st.trending = await M.ponsTrending();
    st.trendingFailed = false;
  } catch {
    st.trendingFailed = !st.trending?.length;
  }
  if (route().page === "") renderKing();
}

// One delegated click handler for cards / buttons anywhere.
app.addEventListener("click", (e) => {
  const q = e.target.closest("[data-qbuy]");
  if (q) { e.stopPropagation(); return quickBuy(q.dataset.qbuy, q); }
  const v = e.target.closest("[data-vamp]");
  if (v) { e.stopPropagation(); return go(`#/vamp/${v.dataset.vamp}`); }
  const c = e.target.closest("[data-token]");
  if (c && !e.target.closest("a, button, input")) go(`#/token/${c.dataset.token}`);
});

async function quickBuy(token, btn) {
  const t = st.tokens.get(token.toLowerCase());
  if (!t) return go(`#/token/${token}`);
  btn && (btn.disabled = true);
  try {
    await ensureConn();
    const amount = parseEther(String(S.quickBuy || "0"));
    if (!amount) throw new Error("Set a quick-buy amount in Settings.");
    toast(`Buying ${S.quickBuy} Ξ of $${esc(t.symbol)}…`);
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
        app.innerHTML = `<div class="panel empty">Not a Pons v2 launch. <a class="btn primary" href="#/vamp/${esc(addr)}" style="margin-left:8px">🧛 Vamp it instead</a></div>`;
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
        <td>${Number(formatEther(b ? l.args.quoteIn : l.args.quoteOut)).toFixed(4)} Ξ</td>
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
          <div><span>Press <kbd>Enter</kbd>. It launches on Pons v2${S.devBuy && Number(S.devBuy) > 0 ? ` with a ${esc(S.devBuy)} Ξ dev buy` : ""}.</span></div>
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
    vstatus(`Vamping <b>${esc(meta.name)}</b> ($${esc(meta.symbol)})${devBuyWei ? ` + ${esc(S.devBuy)} Ξ dev buy` : ""}… confirm in wallet`);
    const res = await launchVamp({ client, wallet: st.conn.wallet, account: st.conn.account, meta, opts: { creatorTaxBps: S.tax, buyback: S.buyback, devBuyWei } });
    vampHistory.unshift({ ...res, name: meta.name, symbol: meta.symbol, logo: meta.logo, from: src.ca, at: Date.now() });
    vampHistory = vampHistory.slice(0, 100);
    save("ponsvamp.history", vampHistory);
    vstatus(`✅ Launched <b>$${esc(meta.symbol)}</b> → <a href="#/token/${res.token}" style="color:var(--accent2)">${short(res.token)}</a>${txLink(res.hash)}`, "ok");
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
      ${h.token ? `<a class="btn sm" href="#/token/${h.token}">Open</a>` : ""}
    </div>`).join("") : `<div class="empty">Nothing vamped yet.</div>`;
}

// ── portfolio ───────────────────────────────────────────────────────────────
async function renderPortfolio() {
  const a = addrOf(st.conn);
  if (!a) {
    app.innerHTML = `<div class="panel empty" style="padding:60px">
      <h2 style="justify-content:center;margin-bottom:10px">Connect to see your portfolio</h2>
      <p class="muted">Holdings, your launches and claimable creator fees.</p>
      <button class="btn primary" id="pfConnect">Connect wallet</button></div>`;
    $("#pfConnect").onclick = () => connect().then(renderPortfolio).catch((e) => toast(errMsg(e), "err"));
    return;
  }
  app.innerHTML = `
  <section class="pf">
    <div style="display:grid;gap:22px">
      <div class="panel section">
        <span class="muted">Wallet</span>
        <div class="mono">${short(a)} <a href="${scan("address/" + a)}" target="_blank" rel="noopener" class="muted">↗</a></div>
        <div class="big-num" id="pfBal">…</div>
      </div>
      <div class="panel section">
        <span class="muted">Claimable creator fees</span>
        <div class="big-num" id="pfFees">…</div>
        <button class="btn primary" id="pfClaim" disabled>Claim</button>
      </div>
    </div>
    <div style="display:grid;gap:22px">
      <div class="panel section"><h2>Holdings</h2><div class="list" id="pfHold"><div class="skel"></div></div></div>
      <div class="panel section"><h2>Your launches</h2><div class="list" id="pfLaunch"><div class="skel"></div></div></div>
    </div>
  </section>`;
  client.getBalance({ address: a }).then((b) => ($("#pfBal").textContent = eth(b, 4))).catch(() => {});
  M.claimable(client, a).then((f) => {
    $("#pfFees").textContent = eth(f, 5);
    $("#pfClaim").disabled = !f;
    $("#pfClaim").onclick = async () => {
      $("#pfClaim").disabled = true;
      try { const h = await M.claimFees({ client, wallet: st.conn.wallet, account: st.conn.account }); toast(`✅ Fees claimed${txLink(h)}`, "ok"); renderPortfolio(); }
      catch (e) { toast(`❌ ${errMsg(e)}`, "err"); $("#pfClaim").disabled = false; }
    };
  }).catch(() => ($("#pfFees").textContent = "—"));

  // launches by this wallet (deployer is an indexed topic, so this is one cheap scan)
  M.fetchRecentLaunches(client, { want: 50, maxChunks: 200, deployer: a }).then(async ({ launches }) => {
    const list = launches.map((t) => addToken(t));
    await Promise.all(list.map((t) => (t.name ? M.loadLive(client, t) : M.loadMeta(client, t).then(() => M.loadLive(client, t)))));
    $("#pfLaunch").innerHTML = list.length ? list.map(row).join("") : `<div class="empty">No Pons v2 launches from this wallet in recent history. <a href="#/vamp" style="color:var(--accent2)">Vamp one →</a></div>`;
  }).catch((e) => ($("#pfLaunch").innerHTML = `<div class="empty">${errMsg(e)}</div>`));

  // holdings among every token we know about
  const known = [...st.tokens.values()];
  const bals = await Promise.all(known.map((t) => M.tokenBalance(client, t.token, a).catch(() => 0n)));
  const held = known.map((t, i) => ({ t, bal: bals[i] })).filter((x) => x.bal > 0n)
    .map((x) => ({ ...x, val: (x.t.priceEth || 0) * Number(formatUnits(x.bal, 18)) }))
    .sort((p, q) => q.val - p.val);
  $("#pfHold") && ($("#pfHold").innerHTML = held.length
    ? held.map(({ t, bal, val }) => row(t, `${compact(Number(formatUnits(bal, 18)))} · ${usd(val)}`)).join("")
    : `<div class="empty">No balances in tracked Pons tokens.</div>`);
}
function row(t, extra) {
  return `<div class="item" data-token="${t.token}" style="cursor:pointer">
    ${avatar(t)}
    <div style="flex:1;min-width:0"><b>${esc(t.name)}</b> <span class="muted">$${esc(t.symbol)}</span>
      <div class="muted" style="font-size:12px">${extra ?? `MC ${usd(t.mcapEth)} · ${Math.round((t.progress || 0) * 100)}%`}</div></div>
    <a class="btn sm" href="#/token/${t.token}">Trade</a>
  </div>`;
}

// ── global paste / quick box ────────────────────────────────────────────────
$("#quickCA").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const ca = extractCA(e.target.value);
  if (!ca) return toast("No valid CA in that text.", "err");
  e.target.value = "";
  go(`#/vamp/${ca}`);
});
$("#quickCA").addEventListener("paste", (e) => {
  const ca = extractCA(e.clipboardData?.getData("text"));
  if (!ca) return;
  e.preventDefault();
  e.target.value = "";
  go(`#/vamp/${ca}`);
});
// Ctrl/Cmd+V anywhere (outside inputs) → vamp that CA
document.addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea")) return;
  const ca = extractCA(e.clipboardData?.getData("text"));
  if (!ca) return;
  e.preventDefault();
  if (route().page === "vamp" && $("#ca")) { $("#ca").value = ca; $("#ca").focus(); loadCA(ca, { autoLaunch: S.insta }); }
  else go(`#/vamp/${ca}`);
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
loadTrending();
setInterval(loadTrending, 30000);
setInterval(pollLaunches, 6000);
setInterval(pollTrades, 5000);
setInterval(pollLive, 15000);
setInterval(updatePrices, 60000);
setInterval(refreshGraduated, 60000);
if (S.wallet === "burner" && S.burner) connect().catch(() => {});
else if (window.ethereum?.selectedAddress) connect().catch(() => {});
