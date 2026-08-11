import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist-production-runtime",
    rolldownOptions: { output: { entryFileNames: "poietra-production-runtime.mjs" } },
    ssr: "server/production-runtime-entry.ts",
  },
  ssr: { noExternal: true },
});
