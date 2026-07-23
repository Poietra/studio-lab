import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist-electron",
    rolldownOptions: {
      output: {
        entryFileNames: "app-main.mjs",
      },
    },
    ssr: "electron/app-main.ts",
  },
  ssr: {
    external: ["electron"],
    noExternal: true,
  },
});
