import { defineConfig } from "vite";

// Pons' public API sends no CORS headers, so the browser reaches it through a
// same-origin path: /pons-api/* → https://ponsfamily.com/api/*.
// In production the same rewrite lives in vercel.json.
const ponsProxy = {
  "/pons-api": {
    target: "https://ponsfamily.com",
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/pons-api/, "/api"),
  },
};

export default defineConfig({
  server: { proxy: ponsProxy },
  preview: { host: "0.0.0.0", allowedHosts: true, proxy: ponsProxy },
});
