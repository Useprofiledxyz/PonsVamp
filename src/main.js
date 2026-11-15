import { formatEther, parseEther } from "viem";
import {
  DEFAULT_RPC,
  PONS_V2_FACTORY,
  displayLogo,
  extractCA,
  factoryAbi,
  fetchTokenMeta,
  getWallet,
  launchVamp,
  makeChain,
  makePublicClient,
} from "./pons.js";

const $ = (id) => document.getElementById(id);

// ── settings (per-browser) ──────────────────────────────────────────────────
const DEFAULTS = {
  wallet: "injected",
  burner: "",
  devBuy: "0",
  tax: 0,
  buyback: true,
  copySocials: true,
  copyDesc: true,
  prefix: "",
  suffix: "",
  rpc: DEFAULT_RPC,
  link: "https://www.ponsfamily.com/launchpad/{token}",
  insta: false,
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let S = { ...DEFAULTS, ...load("ponsvamp.settings", {}) };
let history = load("ponsvamp.history", []);

let chain = makeChain(S.rpc);
let client = makePublicClient(chain);
let conn = null; // { wallet, account }
let current = null; // fetched meta for the pasted CA
let busy = false;

// ── status / history ────────────────────────────────────────────────────────
function status(msg, kind = "") {
  const el = $("status");
  el.className = "status " + kind;
  el.innerHTML = msg;
}
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const scan = (p) => `${chain.blockExplorers.default.url}/${p}`;

function renderHistory() {
  $("history").innerHTML = history.length
    ? history.map((h) => `
      <li>
        ${h.logo ? `<img src="${esc(displayLogo(h.logo))}" alt="">` : ""}
        <b>${esc(h.name)}</b> <span class="muted">$${esc(h.symbol)}</span>
        <code>${h.token ? short(h.token) : "?"}</code>
        ${h.token ? `<a href="${esc(S.link.replace("{token}", h.token))}" target="_blank" rel="noopener">pons</a>
        <a href="${scan("token/" + h.token)}" target="_blank" rel="noopener">scan</a>
        <a href="#" data-copy="${h.token}">copy CA</a>` : ""}
        <a href="${scan("tx/" + h.hash)}" target="_blank" rel="noopener">tx</a>
        <span class="muted">vamped ${short(h.from)}</span>
      </li>`).join("")
    : `<li class="muted">Nothing yet.</li>`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
$("history").addEventListener("click", (e) => {
  const ca = e.target.dataset?.copy;
  if (ca) { e.preventDefault(); navigator.clipboard?.writeText(ca); status(`Copied ${ca}`, "ok"); }
});

// ── wallet ──────────────────────────────────────────────────────────────────
async function connect() {
  conn = await getWallet(S.wallet, chain, S.burner);
  const addr = typeof conn.account === "string" ? conn.account : conn.account.address;
  const bal = await client.getBalance({ address: addr }).catch(() => null);
  $("walletInfo").textContent = `${short(addr)}${bal !== null ? " · " + Number(formatEther(bal)).toFixed(4) + " ETH" : ""}`;
  $("connectBtn").textContent = S.wallet === "burner" ? "Burner" : "Connected";
  return conn;
}
$("connectBtn").onclick = () => connect().catch((e) => status(e.shortMessage || e.message, "err"));

// ── paste → preview ─────────────────────────────────────────────────────────
function fillPreview(m) {
  const sym = (S.prefix + m.symbol + S.suffix).trim();
  $("pName").value = m.name;
  $("pSymbol").value = sym;
  $("pLogoUrl").value = m.logo;
  $("pLogo").src = displayLogo(m.logo);
  $("pDesc").value = S.copyDesc ? m.description : "";
  $("sTwitter").value = S.copySocials ? m.socials.twitter : "";
  $("sTelegram").value = S.copySocials ? m.socials.telegram : "";
  $("sWebsite").value = S.copySocials ? m.socials.website : "";
  $("pSource").textContent = `source: ${m.source} · ${short(m.ca)}`;
  $("preview").classList.remove("hidden");
}
$("pLogoUrl").oninput = () => { $("pLogo").src = displayLogo($("pLogoUrl").value); };

let loadSeq = 0;
async function loadCA(raw, { autoLaunch = false } = {}) {
  const ca = extractCA(raw);
  if (!ca) { current = null; $("preview").classList.add("hidden"); if (raw.trim()) status("No valid CA found in that text.", "err"); return; }
  if (current?.ca === ca) { if (autoLaunch) vamp(); return; }
  const seq = ++loadSeq;
  status(`Reading ${short(ca)}…`);
  try {
    const m = await fetchTokenMeta(client, ca);
    if (seq !== loadSeq) return; // a newer paste won
    current = m;
    fillPreview(m);
    status(`Loaded <b>${esc(m.name)}</b> ($${esc(m.symbol)}). Press Enter to vamp.`, "ok");
    if (autoLaunch) vamp();
  } catch (e) {
    if (seq !== loadSeq) return;
    current = null;
    $("preview").classList.add("hidden");
    status(`Could not read token ${short(ca)} on Robinhood Chain: ${esc(e.shortMessage || e.message)}`, "err");
  }
}

const caInput = $("ca");
caInput.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") || "";
  e.preventDefault();
  caInput.value = extractCA(text) || text.trim();
  loadCA(text, { autoLaunch: $("insta").checked });
});
caInput.addEventListener("input", () => {
  // typed/dropped CA: load once it's a full address
  if (extractCA(caInput.value)) loadCA(caInput.value);
});

// Enter anywhere (except in the description box) = VAMP
document.addEventListener("keydown", (e) => {
  if ($("settings").open) return;
  if (e.key === "Enter" && !e.shiftKey && e.target.id !== "pDesc") {
    e.preventDefault();
    if (current && extractCA(caInput.value) === current.ca) vamp();
    else loadCA(caInput.value, { autoLaunch: true });
  }
});
// Ctrl/Cmd+V anywhere on the page goes to the CA box
document.addEventListener("paste", (e) => {
  if (e.target === caInput || e.target.closest?.("input, textarea")) return;
  const text = e.clipboardData?.getData("text") || "";
  if (!extractCA(text)) return;
  e.preventDefault();
  caInput.value = extractCA(text);
  caInput.focus();
  loadCA(text, { autoLaunch: $("insta").checked });
});

// ── launch ──────────────────────────────────────────────────────────────────
async function vamp() {
  if (busy || !current) return;
  const meta = {
    ...current,
    name: $("pName").value.trim(),
    symbol: $("pSymbol").value.trim(),
    logo: $("pLogoUrl").value.trim(),
    description: $("pDesc").value.trim(),
    socials: {
      ...current.socials,
      ...(S.copySocials ? {} : { discord: "", farcaster: "" }),
      twitter: $("sTwitter").value.trim(),
      telegram: $("sTelegram").value.trim(),
      website: $("sWebsite").value.trim(),
    },
  };
  if (!meta.name || !meta.symbol) return status("Name and ticker are required.", "err");

  busy = true;
  $("vampBtn").disabled = true;
  try {
    if (!conn) await connect();
    const devBuyWei = parseEther(String(S.devBuy || "0"));
    status(`Vamping <b>${esc(meta.name)}</b> ($${esc(meta.symbol)})${devBuyWei ? ` + ${S.devBuy} ETH dev buy` : ""}… confirm in wallet`);
    const res = await launchVamp({
      client, wallet: conn.wallet, account: conn.account, meta,
      opts: { creatorTaxBps: S.tax, buyback: S.buyback, devBuyWei },
    });
    history.unshift({ ...res, name: meta.name, symbol: meta.symbol, logo: meta.logo, from: current.ca, at: Date.now() });
    history = history.slice(0, 100);
    save("ponsvamp.history", history);
    renderHistory();
    status(`✅ Launched <b>$${esc(meta.symbol)}</b> → <code>${res.token ?? "?"}</code> · <a href="${scan("tx/" + res.hash)}" target="_blank" rel="noopener">tx</a>`, "ok");
    caInput.value = "";
    current = null;
    $("preview").classList.add("hidden");
    caInput.focus();
    connect().catch(() => {}); // refresh balance
  } catch (e) {
    const msg = e.shortMessage || e.message || String(e);
    status(`❌ ${esc(msg)}${e.hash ? ` · <a href="${scan("tx/" + e.hash)}" target="_blank" rel="noopener">tx</a>` : ""}`, "err");
  } finally {
    busy = false;
    $("vampBtn").disabled = false;
  }
}
$("vampBtn").onclick = vamp;

// ── settings dialog ─────────────────────────────────────────────────────────
function openSettings() {
  $("optWallet").value = S.wallet;
  $("optBurner").value = S.burner;
  $("optDevBuy").value = S.devBuy;
  $("optTax").value = S.tax;
  $("optBuyback").checked = S.buyback;
  $("optCopySocials").checked = S.copySocials;
  $("optCopyDesc").checked = S.copyDesc;
  $("optPrefix").value = S.prefix;
  $("optSuffix").value = S.suffix;
  $("optRpc").value = S.rpc;
  $("optLink").value = S.link;
  $("burnerRow").style.display = S.wallet === "burner" ? "" : "none";
  $("settings").showModal();
}
$("optWallet").onchange = () => { $("burnerRow").style.display = $("optWallet").value === "burner" ? "" : "none"; };
$("settingsBtn").onclick = openSettings;
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  let burner = $("optBurner").value.trim();
  if (burner && !burner.startsWith("0x")) burner = "0x" + burner;
  const rpc = $("optRpc").value.trim() || DEFAULT_RPC;
  S = {
    ...S,
    wallet: $("optWallet").value,
    burner,
    devBuy: $("optDevBuy").value || "0",
    tax: Math.max(0, Math.min(Number($("optTax").value) || 0, Number($("maxTax").textContent) || 1000)),
    buyback: $("optBuyback").checked,
    copySocials: $("optCopySocials").checked,
    copyDesc: $("optCopyDesc").checked,
    prefix: $("optPrefix").value,
    suffix: $("optSuffix").value,
    rpc,
    link: $("optLink").value.trim() || DEFAULTS.link,
  };
  save("ponsvamp.settings", S);
  chain = makeChain(S.rpc);
  client = makePublicClient(chain);
  conn = null;
  $("walletInfo").textContent = "not connected";
  $("connectBtn").textContent = "Connect";
  renderHistory();
  caInput.focus();
});

$("insta").checked = !!S.insta;
$("insta").onchange = () => { S.insta = $("insta").checked; save("ponsvamp.settings", S); };

// live protocol numbers
Promise.all([
  client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "launchFee" }),
  client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
]).then(([fee, maxTax]) => {
  $("maxTax").textContent = String(maxTax);
  status(`Pons v2 launch fee: ${formatEther(fee)} ETH. Paste a CA.`);
}).catch(() => status("Paste a CA."));

renderHistory();
caInput.focus();
if (S.wallet === "burner" && S.burner) connect().catch(() => {});
