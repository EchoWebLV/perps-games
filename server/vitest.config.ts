import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const engineSrc = fileURLToPath(new URL("../packages/engine/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@perps\/engine\/(.*)$/, replacement: `${engineSrc}/$1.ts` },
      { find: "@perps/engine", replacement: `${engineSrc}/index.ts` },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
  },
});
