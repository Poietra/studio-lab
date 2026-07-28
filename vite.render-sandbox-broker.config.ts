import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist-render-sandbox-broker",
    rolldownOptions: { output: { entryFileNames: "manim-render-sandbox-broker.mjs" } },
    ssr: "server/manim-render-production-sandbox-broker-entry.ts",
  },
  ssr: { noExternal: true },
});
