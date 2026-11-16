// Market data + trading for Pons v2 launches on Robinhood Chain.
// Everything is read straight from chain (factory events, curves, tokens);
// DexScreener is only used for graduated-token prices and the ETH/USD rate.
import { erc20Abi, parseAbi, parseAbiItem } from "viem";
import { PONS_V2_FACTORY, PONS_V2_FEE_ESCROW, factoryAbi, v2TokenAbi } from "./pons.js";

export const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
]);
export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function claim()",
]);
const launchedEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);

const BPS = 10_000n;
const CHUNK = 50_000n; // ~85 min of blocks per getLogs call

// ── launch feed ─────────────────────────────────────────────────────────────
/** Walk back from head until `want` launches are found (or `maxChunks` ranges scanned). */
export async function fetchRecentLaunches(client, { want = 90, maxChunks = 60, deployer } = {}) {
  const head = await client.getBlockNumber();
  const out = [];
  let to = head;
  for (let i = 0; i < maxChunks && out.length < want && to > 0n; i++) {
    const from = to > CHUNK ? to - CHUNK + 1n : 0n;
    const logs = await client.getLogs({
      address: PONS_V2_FACTORY, event: launchedEvent, fromBlock: from, toBlock: to,
      args: deployer ? { deployer } : undefined,
    });
    out.unshift(...logs);
    to = from - 1n;
  }
  return { head, launches: out.reverse().map(toLaunch) };
}

/** New launches since `fromBlock` (inclusive). */
export async function fetchLaunchesSince(client, fromBlock) {
  const head = await client.getBlockNumber();
  if (head < fromBlock) return { head, launches: [] };
  const logs = await client.getLogs({ address: PONS_V2_FACTORY, event: launchedEvent, fromBlock, toBlock: head });
  return { head, launches: logs.reverse().map(toLaunch) };
}

function toLaunch(l) {
  return {
    token: l.args.token,
    curve: l.args.curve,
    deployer: l.args.deployer,
    pairToken: l.args.pairToken,
    threshold: l.args.graduationThreshold,
    block: l.blockNumber,
    tx: l.transactionHash,
  };
}

// ── per-token state ─────────────────────────────────────────────────────────
/** Static metadata, read once per token (multicall-batched by the client). */
export async function loadMeta(client, t) {
  const r = (address, abi, functionName) => client.readContract({ address, abi, functionName }).catch(() => null);
  const [name, symbol, supply, info] = await Promise.all([
    r(t.token, erc20Abi, "name"),
    r(t.token, erc20Abi, "symbol"),
    r(t.token, erc20Abi, "totalSupply"),
    r(t.token, v2TokenAbi, "getTokenInfo"),
  ]);
  t.name = name ?? "?";
  t.symbol = symbol ?? "?";
  t.supply = supply ?? 10n ** 27n;
  if (info) {
    const [, logo, description, socials] = info;
    Object.assign(t, { logo, description, socials });
  }
  return t;
}

/** Live curve state: reserves, progress, phase. Cheap; refreshed on a timer. */
export async function loadLive(client, t) {
  const r = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, args }).catch(() => null);
  const [reserves, real, launched] = await Promise.all([
    r(t.curve, curveAbi, "getReserves"),
    r(t.curve, curveAbi, "realQuoteReserve"),
    r(PONS_V2_FACTORY, factoryAbi, "getLaunchedToken", [t.token]),
  ]);
  if (reserves) [t.quoteReserve, t.tokenReserve] = reserves;
  if (real !== null) t.raised = real;
  if (launched) {
    t.phase = Number(launched.phase);
    t.threshold = launched.graduationThreshold || t.threshold;
    t.creatorTaxBps = Number(launched.creatorTaxBps);
  }
  t.progress = t.phase >= 1 ? 1 : t.threshold ? Math.min(1, Number(t.raised ?? 0n) / Number(t.threshold)) : 0;
  // Spot price (ETH per whole token) and market cap in ETH.
  if (t.quoteReserve && t.tokenReserve) {
    t.priceEth = Number(t.quoteReserve) / Number(t.tokenReserve);
    t.mcapEth = t.priceEth * (Number(t.supply ?? 10n ** 27n) / 1e18);
  }
  return t;
}

/** Prices for graduated tokens + ETH/USD, from DexScreener (≤30 tokens per call). */
export async function dexPrices(addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${batch.join(",")}`);
      if (!r.ok) continue;
      for (const p of await r.json()) {
        const a = p.baseToken?.address?.toLowerCase();
        if (!a || out[a]) continue;
        out[a] = {
          priceUsd: Number(p.priceUsd) || 0,
          priceNative: Number(p.priceNative) || 0,
          mcapUsd: p.marketCap || p.fdv || 0,
          volume24: p.volume?.h24 || 0,
          change24: p.priceChange?.h24 ?? null,
          url: p.url,
        };
      }
    } catch {}
  }
  return out;
}

const PONS_TOKEN = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
/** ETH/USD derived from a liquid ETH-quoted pair on Robinhood Chain. */
export async function ethUsd() {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${PONS_TOKEN}`);
    const d = await r.json();
    const p = (d.pairs || []).find((x) => x.chainId === "robinhood" && Number(x.priceNative) > 0 && /W?ETH/i.test(x.quoteToken?.symbol || ""));
    return p ? Number(p.priceUsd) / Number(p.priceNative) : null;
  } catch {
    return null;
  }
}

// ── quotes (the curve's own integer arithmetic, from the Pons docs) ─────────
const amountOut = (inAmt, rIn, rOut) => (inAmt * rOut) / (rIn + inAmt);

export async function quoteBuy(client, curve, quoteIn, recipient) {
  const r = (fn, args) => client.readContract({ address: curve, abi: curveAbi, functionName: fn, args });
  const [[qR, tR], sellable, feeBps, taxBps, rawSnipe] = await Promise.all([
    r("getReserves"), r("sellableTokens"), r("feeBps"), r("creatorTaxBps"),
    r("currentSnipeTaxBps", [recipient]).catch(() => 0n),
  ]);
  let snipe = rawSnipe;
  const cap = BPS - feeBps - taxBps - 100n;
  if (snipe > cap) snipe = cap;
  const net = quoteIn - (quoteIn * feeBps) / BPS - (quoteIn * taxBps) / BPS - (quoteIn * snipe) / BPS;
  let tokensOut = amountOut(net, qR, tR);
  if (tokensOut > sellable) tokensOut = sellable;
  return { tokensOut, feeBps, taxBps, snipeBps: snipe };
}

export async function quoteSell(client, curve, tokensIn) {
  const r = (fn) => client.readContract({ address: curve, abi: curveAbi, functionName: fn });
  const [[qR, tR], feeBps, taxBps] = await Promise.all([r("getReserves"), r("feeBps"), r("creatorTaxBps")]);
  const gross = amountOut(tokensIn, tR, qR);
  return { quoteOut: gross - (gross * feeBps) / BPS - (gross * taxBps) / BPS, feeBps, taxBps };
}

const applySlippage = (x, bps) => (x * (BPS - BigInt(bps))) / BPS;

// ── trades ──────────────────────────────────────────────────────────────────
export async function buy({ client, wallet, account, curve, quoteIn, slippageBps = 1000 }) {
  const from = typeof account === "string" ? account : account.address;
  const q = await quoteBuy(client, curve, quoteIn, from);
  const hash = await wallet.writeContract({
    address: curve, abi: curveAbi, functionName: "buy",
    args: [quoteIn, applySlippage(q.tokensOut, slippageBps), from],
    value: quoteIn, account, chain: wallet.chain,
  });
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw Object.assign(new Error("Buy reverted."), { hash });
  return { hash, ...q };
}

export async function sell({ client, wallet, account, token, curve, tokensIn, slippageBps = 1000 }) {
  const from = typeof account === "string" ? account : account.address;
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [from, curve] });
  if (allowance < tokensIn) {
    const ah = await wallet.writeContract({
      address: token, abi: erc20Abi, functionName: "approve",
      args: [curve, 2n ** 256n - 1n], account, chain: wallet.chain,
    });
    await client.waitForTransactionReceipt({ hash: ah });
  }
  const q = await quoteSell(client, curve, tokensIn);
  const hash = await wallet.writeContract({
    address: curve, abi: curveAbi, functionName: "sell",
    args: [tokensIn, applySlippage(q.quoteOut, slippageBps), from],
    account, chain: wallet.chain,
  });
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw Object.assign(new Error("Sell reverted."), { hash });
  return { hash, ...q };
}

export const tokenBalance = (client, token, owner) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

// ── creator fees ────────────────────────────────────────────────────────────
export const claimable = (client, owner) =>
  client.readContract({ address: PONS_V2_FEE_ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [owner] });

export async function claimFees({ client, wallet, account }) {
  const hash = await wallet.writeContract({
    address: PONS_V2_FEE_ESCROW, abi: escrowAbi, functionName: "claim", account, chain: wallet.chain,
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
