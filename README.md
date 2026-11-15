# Pons Vamp 🧛

Vamp mode untuk [Pons](https://docs.ponsfamily.com/v2) di Robinhood Chain (chain id 4663).
Paste CA → Enter → coin kembaran langsung launch di Pons v2.

## Cara pakai

```bash
npm install
npm run dev
```

Buka `http://localhost:5173`, lalu:

1. **Paste CA** (atau link apa pun yang berisi CA: dexscreener, blockscout, pons…) di kotak atas.
   Ctrl/Cmd+V di mana saja di halaman juga langsung masuk ke kotak itu.
2. Nama, ticker, logo, deskripsi, dan socials token sumber langsung terisi (bisa diedit).
3. **Enter** → launch di Pons v2.
4. **Insta-vamp** dicentang = langsung launch begitu CA di-paste (tanpa Enter).

## Sumber metadata

Semua memecoin di Robinhood Chain bisa di-vamp:

| Token sumber | Dibaca dari |
|---|---|
| Pons v2 | `getTokenInfo()` on-chain (logo, deskripsi, socials) |
| Pons v1 | `logo()` / `description()` / `socials()` on-chain |
| Lainnya (Pools, Noxa, ERC-20 biasa) | `name()`/`symbol()` on-chain + logo & socials dari DexScreener |

Logo dipakai ulang apa adanya (URL / `ipfs://`), jadi tidak perlu upload gambar.

## Settings (⚙)

- **Wallet**: browser wallet (MetaMask/Rabby, otomatis add/switch ke Robinhood Chain) atau
  **burner key** — sign langsung tanpa popup, paling cepat. Key disimpan di localStorage
  browser, jadi pakai hot wallet berisi sedikit dana saja.
- **Dev buy (ETH)**: > 0 akan memakai router `launchAndBuy` — launch + beli dalam satu tx (atomic, tidak bisa disnipe).
- **Creator tax (bps)**, **buyback**, copy socials/deskripsi on/off, **prefix/suffix ticker**, RPC custom.

## Kontrak (Pons v2, dari docs resmi)

| | |
|---|---|
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch and buy | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |

Launch memakai launch config `0`, pair native ETH, fee dibaca live dari `launchFee()`
(saat ini 0.0005 ETH), dan `canLaunch(address)` dicek sebelum kirim tx.

## Build / deploy

```bash
npm run build
```

Hasilnya static di `dist/` — bisa di-deploy ke Vercel/Netlify/Railway/GitHub Pages.
