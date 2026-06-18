import { defineConfig } from "vite";

export default defineConfig({
  // serve dev on :3000 (and expose on LAN so a phone can hit http://<your-ip>:3000).
  // allowedHosts:true lets an ngrok/cloudflare tunnel (random https host) through
  // Vite's host check — needed to install the PWA on the Seeker over HTTPS.
  server: { port: 3000, strictPort: true, host: true, allowedHosts: true },
  // one Three.js instance across core + examples/jsm addons (loaders, postprocessing)
  resolve: { dedupe: ["three"] },
  test: { globals: true, environment: "node" },
  build: { target: "es2020" },
});
