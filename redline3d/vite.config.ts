import { defineConfig } from "vite";

export default defineConfig({
  // one Three.js instance across core + examples/jsm addons (loaders, postprocessing)
  resolve: { dedupe: ["three"] },
  test: { globals: true, environment: "node" },
  build: { target: "es2020" },
});
