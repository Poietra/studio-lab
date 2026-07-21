import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { openAiEditSuggestions } from "./server/openai-edit-suggestions";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      tailwindcss(),
      openAiEditSuggestions({ model: env.POIETRA_OPENAI_MODEL }),
    ],
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
