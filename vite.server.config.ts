import { defineConfig } from "vite";
import { thirdPartyNotices } from "./scripts/vite-third-party-notices";

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
    ssrEmitAssets: true,
  },
  plugins: [thirdPartyNotices()],
  ssr: {
    noExternal: true,
  },
});
