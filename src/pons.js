import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Robinhood Chain ─────────────────────────────────────────────────────────
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

export function makeChain(rpc = DEFAULT_RPC) {
  return defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: {
      default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
    },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
}

// ── Pons v2 (docs.ponsfamily.com/v2 → Contracts) ────────────────────────────
export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const PONS_V2_LAUNCH_AND_BUY = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948";
export const PONS_V1_FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
export const PONS_V2_FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";

const SOCIALS = "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }";
const TOKEN_PARAMS =
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }";

export const factoryAbi = parseAbi([
  SOCIALS,
  TOKEN_PARAMS,
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

export const routerAbi = parseAbi([
  SOCIALS,
  TOKEN_PARAMS,
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);

const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
export const v2TokenAbi = parseAbi([
  SOCIALS,
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
]);
const v1TokenAbi = parseAbi([
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)",
]);

const emptySocials = () => ({ twitter: "", telegram: "", discord: "", website: "", farcaster: "" });

/** Pull an address out of whatever was pasted (raw CA, dexscreener/blockscout/pons link…). */
export function extractCA(text) {
  const m = String(text || "").match(/0x[a-fA-F0-9]{40}/);
  return m && isAddress(m[0]) ? getAddress(m[0]) : null;
}

// ── token logos ─────────────────────────────────────────────────────────────
// ipfs.io / dweb.link rate-limit (HTTP 429), which is what made logos slow.
// Every logo goes through wsrv.nl: an image CDN (Cloudflare) that resizes to the
// size we actually draw, converts to WebP (~1-3 KB) and caches for a year.
// IPFS content is fetched from gateways that answer wsrv reliably.
const IPFS_GATEWAYS = ["https://4everland.io/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

/** "ipfs://cid", "ipfs://ipfs/cid" or "https://any-gateway/ipfs/cid" → "cid[/path]". */
function ipfsPath(logo) {
  if (logo.startsWith("ipfs://")) return logo.slice(7).replace(/^ipfs\//, "");
  const m = logo.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/);
  return m ? m[1] : null;
}
const wsrv = (url, px) => `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=${px}&h=${px}&fit=cover&output=webp&q=80`;

/** Ordered list of URLs to try for a logo drawn at `px` CSS pixels (fetched at 2× for sharp screens). */
export function logoSources(logo, px = 52) {
  if (!logo) return [];
  logo = logo.trim();
  if (logo.startsWith("data:")) return [logo];
  const size = Math.min(512, Math.round(px * 2));
  const p = ipfsPath(logo);
  if (p) return [wsrv(IPFS_GATEWAYS[0] + p, size), wsrv(IPFS_GATEWAYS[1] + p, size), IPFS_GATEWAYS[2] + p];
  if (/^https?:\/\//.test(logo)) return [wsrv(logo, size), logo];
  return [];
}

/** First URL to show for a logo. The original string is what gets launched. */
export function displayLogo(logo, px) {
  return logoSources(logo, px)[0] || "";
}

async function dexscreener(ca) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    if (!r.ok) return null;
    const d = await r.json();
    const pairs = (d.pairs || []).filter((p) => p.chainId === "robinhood");
    if (!pairs.length) return null;
    const p = pairs.find((x) => x.info) || pairs[0];
    const base = p.baseToken?.address?.toLowerCase() === ca.toLowerCase() ? p.baseToken : p.quoteToken;
    const socials = emptySocials();
    for (const s of p.info?.socials || []) {
      const t = (s.type || "").toLowerCase();
      if (t === "twitter" || t === "x") socials.twitter ||= s.url;
      else if (t === "telegram") socials.telegram ||= s.url;
      else if (t === "discord") socials.discord ||= s.url;
      else if (t === "farcaster" || t === "warpcast") socials.farcaster ||= s.url;
    }
    socials.website = p.info?.websites?.[0]?.url || "";
    return { name: base?.name, symbol: base?.symbol, logo: p.info?.imageUrl || "", socials };
  } catch {
    return null;
  }
}

/**
 * Read everything needed to vamp a Robinhood Chain token.
 * Order: Pons v2 getTokenInfo() → Pons v1 logo()/description()/socials() → DexScreener.
 * Name/symbol always come from the ERC-20 itself.
 */
export async function fetchTokenMeta(client, ca) {
  const read = (abi, functionName) => client.readContract({ address: ca, abi, functionName });
  const [name, symbol] = await Promise.all([read(erc20Abi, "name"), read(erc20Abi, "symbol")]);
  const meta = { ca, name, symbol, logo: "", description: "", socials: emptySocials(), source: "erc20" };

  const v2 = await read(v2TokenAbi, "getTokenInfo").catch(() => null);
  if (v2) {
    const [, logo, description, s] = v2;
    Object.assign(meta, { logo, description, socials: { ...emptySocials(), ...s }, source: "pons v2" });
  } else {
    const [logo, description, s] = await Promise.all([
      read(v1TokenAbi, "logo").catch(() => null),
      read(v1TokenAbi, "description").catch(() => null),
      read(v1TokenAbi, "socials").catch(() => null),
    ]);
    if (logo !== null || description !== null) {
      meta.logo = logo || "";
      meta.description = description || "";
      if (s) {
        const [twitter, telegram, discord, website, farcaster] = s;
        meta.socials = { twitter, telegram, discord, website, farcaster };
      }
      meta.source = "pons v1";
    }
  }

  // Fill whatever is still missing (non-Pons tokens: Pools, Noxa, plain ERC-20…) from DexScreener.
  if (!meta.logo || Object.values(meta.socials).every((v) => !v)) {
    const ds = await dexscreener(ca);
    if (ds) {
      meta.logo ||= ds.logo;
      for (const k of Object.keys(meta.socials)) meta.socials[k] ||= ds.socials[k];
      if (meta.source === "erc20") meta.source = "dexscreener";
    }
  }
  return meta;
}

/** Wallet: either a browser wallet (MetaMask/Rabby…) or a local burner key for popup-free launches. */
export async function getWallet(mode, chain, burnerKey) {
  if (mode === "burner") {
    if (!burnerKey) throw new Error("No burner key set (Settings).");
    const account = privateKeyToAccount(burnerKey);
    return { account, wallet: createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) }) };
  }
  const eth = window.ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask/Rabby or use burner mode.");
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  const hexId = toHex(chain.id);
  if ((await eth.request({ method: "eth_chainId" })) !== hexId) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: [chain.blockExplorers.default.url],
        }],
      });
    }
  }
  const account = getAddress(address);
  return { account, wallet: createWalletClient({ account, chain, transport: custom(eth) }) };
}

/**
 * Launch the vamp on Pons v2 (native ETH pair, launch config 0 unless set).
 * devBuyWei > 0 routes through the launch-and-buy router so the dev buy lands in the same tx.
 */
export async function launchVamp({ client, wallet, account, meta, opts }) {
  const from = typeof account === "string" ? account : account.address;
  const configId = BigInt(opts.configId ?? 0);
  const pairToken = zeroAddress;

  const [ok, fee, economics] = await Promise.all([
    client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "canLaunch", args: [from] }),
    client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "launchFee" }),
    client.readContract({ address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [configId, pairToken] }),
  ]);
  if (!ok) throw new Error("This wallet is not allowed to launch on Pons right now (canLaunch = false).");

  const params = {
    name: meta.name,
    symbol: meta.symbol,
    logo: meta.logo || "",
    description: meta.description || "",
    socials: { ...emptySocials(), ...meta.socials },
    creatorFeeRecipient: from,
    creatorTaxBps: Number(opts.creatorTaxBps || 0),
    buybackEnabled: !!opts.buyback,
    expectedEconomics: economics,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };

  const devBuy = BigInt(opts.devBuyWei || 0);
  let hash;
  if (devBuy > 0n) {
    // Launch + buy are atomic in one tx, so nobody can get in between: minTokensOut 0 is safe here.
    hash = await wallet.writeContract({
      address: PONS_V2_LAUNCH_AND_BUY,
      abi: routerAbi,
      functionName: "launchAndBuy",
      args: [params, configId, pairToken, devBuy, 0n, from, []],
      value: fee + devBuy,
      account,
      chain: wallet.chain,
    });
  } else {
    hash = await wallet.writeContract({
      address: PONS_V2_FACTORY,
      abi: factoryAbi,
      functionName: "launchToken",
      args: [params, configId, pairToken],
      value: fee,
      account,
      chain: wallet.chain,
    });
  }

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw Object.assign(new Error("Launch transaction reverted."), { hash });
  const [ev] = parseEventLogs({ abi: factoryAbi, eventName: "TokenLaunched", logs: receipt.logs });
  return { hash, token: ev?.args.token, curve: ev?.args.curve };
}

export function makePublicClient(chain) {
  return createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], { retryCount: 2 }),
    batch: { multicall: { batchSize: 4096, wait: 16 } },
  });
}
