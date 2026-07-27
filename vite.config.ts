import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import {
  manimRenderPipeline,
  parseFastManimSnapshotProducerCommand,
  parseManimProjects,
} from "./server/manim-render-pipeline";
import { openAiEditSuggestions } from "./server/openai-edit-suggestions";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: "./",
    build: {
      rolldownOptions: {
        // The benchmark host entry ships only in explicit benchmark builds;
        // the normal Studio production build never bundles it.
        ...(env.POIETRA_BENCHMARK_BUILD === "1" ? { input: { benchmark: "benchmark.html", main: "index.html" } } : {}),
        output: {
          codeSplitting: {
            groups: [
              {
                name: "react",
                priority: 30,
                test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              },
              {
                name: "katex",
                priority: 20,
                test: /node_modules[\\/]katex[\\/]/,
              },
              {
                name: "zod",
                priority: 20,
                test: /node_modules[\\/]zod[\\/]/,
              },
            ],
          },
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      openAiEditSuggestions({
        apiKey: env.OPENAI_API_KEY,
        logPath: mode === "test" || env.POIETRA_AI_DEBUG_LOG === "off" ? false : env.POIETRA_AI_DEBUG_LOG || undefined,
        model: env.POIETRA_OPENAI_MODEL,
      }),
      manimRenderPipeline({
        command: env.POIETRA_MANIM_COMMAND,
        frameHeight: env.POIETRA_MANIM_FRAME_HEIGHT ? Number(env.POIETRA_MANIM_FRAME_HEIGHT) : undefined,
        frameWidth: env.POIETRA_MANIM_FRAME_WIDTH ? Number(env.POIETRA_MANIM_FRAME_WIDTH) : undefined,
        projects: parseManimProjects(env.POIETRA_MANIM_PROJECTS),
        projectRoot: env.POIETRA_MANIM_PROJECT_ROOT,
        snapshotSandboxDeployment: mode === "production" ? "production" : "development",
        snapshotProducerCommand: parseFastManimSnapshotProducerCommand(env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND),
        snapshotProducerDevOptIn: env.POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN === "1",
        workspaceDataRoot: env.POIETRA_STUDIO_DATA_ROOT,
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
