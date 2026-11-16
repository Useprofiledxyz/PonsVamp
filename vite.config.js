import { defineConfig } from "vite";

// `preview` serves the built site in production (Railway); allow any host so the
// generated *.up.railway.app domain (and custom domains) are accepted.
export default defineConfig({
  preview: { host: "0.0.0.0", allowedHosts: true },
});
