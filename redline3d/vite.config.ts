import { defineConfig } from "vite";

export default defineConfig({
  test: { globals: true, environment: "node" },
  build: { target: "es2020" },
});
