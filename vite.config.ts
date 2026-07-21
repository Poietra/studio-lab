import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { openAiEditSuggestions } from "./server/openai-edit-suggestions";
import { manimRenderPipeline } from "./server/manim-render-pipeline";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      tailwindcss(),
      openAiEditSuggestions({ apiKey: env.OPENAI_API_KEY, model: env.POIETRA_OPENAI_MODEL }),
      manimRenderPipeline({
        command: env.POIETRA_MANIM_COMMAND,
        frameHeight: env.POIETRA_MANIM_FRAME_HEIGHT ? Number(env.POIETRA_MANIM_FRAME_HEIGHT) : undefined,
        frameWidth: env.POIETRA_MANIM_FRAME_WIDTH ? Number(env.POIETRA_MANIM_FRAME_WIDTH) : undefined,
        projectRoot: env.POIETRA_MANIM_PROJECT_ROOT,
      }),
    ],
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: {
        ignored: ["**/*.py", "**/src-tauri/**"],
      },
    },
  };
});
