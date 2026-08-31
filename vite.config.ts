import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve("src/renderer"),
  // Loaded via file:// from the packaged app, so every asset URL must be relative.
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve("dist-renderer"),
    emptyOutDir: true,
    target: "chrome130",
  },
});
