import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: {
      "~": resolve("../..", "src"),
    },
  },
  ssr: {
    external: ["bun:sqlite"],
  },
  build: {
    rollupOptions: {
      external: ["bun:sqlite", /^bun:/],
    },
  },
});