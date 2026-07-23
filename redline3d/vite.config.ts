import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const engineSrc = fileURLToPath(new URL("../packages/engine/src", import.meta.url));

// DEV-ONLY endpoint for the Light Lab's SAVE ALL: POST /__lightlab/save writes the tuned presets back
// to the ONE whitelisted repo file (path hardcoded here — never taken from the request). `apply:"serve"`
// + configureServer keep it strictly out of production builds. It validates the payload against the
// CURRENT file's shape (only known scenes + keys; values must be finite numbers, booleans, or #rrggbb
// hex strings — anything else is rejected 400) so a malformed or hostile POST can't corrupt the file.
function lightLabSavePlugin(): Plugin {
  const FILE = fileURLToPath(new URL("src/config/visual-presets.json", import.meta.url));
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const validValue = (v: unknown): boolean =>
    (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && HEX.test(v));
  return {
    name: "lightlab-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__lightlab/save", (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== "POST") return next();
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        req.on("end", () => {
          const fail = (msg: string) => { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: false, error: msg })); };
          try {
            const incoming = JSON.parse(body) as Record<string, Record<string, unknown>>;
            const current = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Record<string, unknown>>;
            for (const scene of Object.keys(incoming)) {
              if (!Object.prototype.hasOwnProperty.call(current, scene)) return fail(`unknown scene "${scene}"`);
              const sIn = incoming[scene], sCur = current[scene];
              if (typeof sIn !== "object" || sIn === null || Array.isArray(sIn)) return fail(`scene "${scene}" must be an object`);
              for (const key of Object.keys(sIn)) {
                if (!Object.prototype.hasOwnProperty.call(sCur, key)) return fail(`unknown key "${scene}.${key}"`);
                if (!validValue(sIn[key])) return fail(`bad value at "${scene}.${key}"`);
              }
            }
            const merged: Record<string, Record<string, unknown>> = { ...current };
            for (const scene of Object.keys(incoming)) merged[scene] = { ...current[scene], ...incoming[scene] };
            writeFileSync(FILE, JSON.stringify(merged, null, 2) + "\n");
            res.statusCode = 200; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [nodePolyfills({ globals: { Buffer: true, global: true, process: true } }), lightLabSavePlugin()],
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
