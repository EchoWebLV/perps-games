import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Dedicated config for the gated devnet integration test. It deliberately OMITS
// vite-plugin-node-polyfills: that plugin (used by the browser build/main test
// config) replaces `process` with a browser stub whose `process.env` is empty, which
// breaks the test's real-env reads (ANCHOR_WALLET / HOME / RPC) and node:fs keypair
// load. anchor/web3/spl-token are node-native and need no polyfill here. Run:
//   RAIDER_DEVNET=1 ANCHOR_WALLET=~/.config/solana/lazer-probe.json \
//     npx vitest run --config vitest.config.devnet.ts
const engineSrc = fileURLToPath(new URL("../packages/engine/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@perps\/engine\/(.*)$/, replacement: `${engineSrc}/$1.ts` },
      { find: "@perps/engine", replacement: `${engineSrc}/index.ts` },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/chain/chain-round.devnet.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
