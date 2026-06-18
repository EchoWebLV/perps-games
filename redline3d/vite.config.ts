import { defineConfig } from "vite";

export default defineConfig({
  // serve dev on :3000 (and expose on LAN so a phone can hit http://<your-ip>:3000)
  server: { port: 3000, strictPort: true, host: true },
  // one Three.js instance across core + examples/jsm addons (loaders, postprocessing)
  resolve: { dedupe: ["three"] },
  test: { globals: true, environment: "node" },
  build: { target: "es2020" },
});
