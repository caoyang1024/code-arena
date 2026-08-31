import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve("src/renderer"),
  // Loaded via file:// from the packaged app, so every asset URL must be relative.
  base: "./",
  plugins: [react()],
  server: {
    // Let the harness assign a port. Pinning one only causes collisions with a previous
    // run of this same server, and nothing here needs a fixed origin -- no OAuth callback,
    // no webhook, no CORS allowlist.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
  build: {
    outDir: path.resolve("dist-renderer"),
    emptyOutDir: true,
    target: "chrome130",
  },
});
