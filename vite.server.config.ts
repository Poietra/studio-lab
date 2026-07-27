import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist-server",
    rolldownOptions: {
      output: {
        entryFileNames: "manim-production-server.mjs",
      },
    },
    ssr: "server/manim-production-server.ts",
  },
  ssr: {
    noExternal: true,
  },
});
