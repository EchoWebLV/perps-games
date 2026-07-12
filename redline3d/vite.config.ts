import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const engineSrc = fileURLToPath(new URL("../packages/engine/src", import.meta.url));

export default defineConfig({
  plugins: [nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  // serve dev on :3000, or on PORT when a harness assigns one (lets several
  // dev servers coexist; strictPort still fails loudly on a clash). LAN-exposed
  // so a phone can hit http://<your-ip>:<port>.
  // allowedHosts:true lets an ngrok/cloudflare tunnel (random https host) through
  // Vite's host check — needed to install the PWA on the Seeker over HTTPS.
  server: { port: Number(process.env.PORT) || 3000, strictPort: true, host: true, allowedHosts: true },
  // one Three.js instance across core + examples/jsm addons (loaders, postprocessing)
  resolve: {
    dedupe: ["three"],
    alias: [
      { find: /^@perps\/engine\/(.*)$/, replacement: `${engineSrc}/$1.ts` },
      { find: "@perps/engine", replacement: `${engineSrc}/index.ts` },
    ],
  },
  test: { globals: true, environment: "node" },
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL("index.html", import.meta.url)),
        play: fileURLToPath(new URL("play/index.html", import.meta.url)),
      },
    },
  },
});
