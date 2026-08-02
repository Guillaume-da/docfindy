import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const mock = process.env.VITE_MOCK === "1";

// Only the mock needs this: inside the Tauri shell the version comes from the
// app itself via getVersion().
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// When VITE_MOCK=1 the Tauri API modules are swapped for a browser stand-in so
// the UI can be previewed without the Tauri shell. Never used in a real build.
const mockPath = fileURLToPath(new URL("./src/dev/tauri-mock.ts", import.meta.url));
const mockAlias = mock
  ? [
      { find: "@tauri-apps/api/core", replacement: mockPath },
      { find: "@tauri-apps/api/event", replacement: mockPath },
      { find: "@tauri-apps/api/app", replacement: mockPath },
      { find: "@tauri-apps/plugin-dialog", replacement: mockPath },
      { find: "@tauri-apps/plugin-opener", replacement: mockPath },
    ]
  : [];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: { alias: mockAlias },

  define: { __APP_VERSION__: JSON.stringify(appVersion) },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
