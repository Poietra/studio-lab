import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist-sandbox-broker",
    rolldownOptions: { output: { entryFileNames: "fast-manim-sandbox-broker.mjs" } },
    ssr: "server/fast-manim-production-sandbox-broker-entry.ts",
  },
  ssr: { noExternal: true },
});
