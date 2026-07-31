import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
if (args.length !== 3 && !(args.length === 2 && args[0] === "--verify")) {
  console.error("Usage: pnpm benchmark:engine:webgpu:promote -- <benchmark.json> <stress.json> <stage-telemetry.json>");
  console.error("   or: pnpm benchmark:engine:webgpu:verify -- <checked-in-evidence-directory>");
  process.exitCode = 2;
} else {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const evidence = await vite.ssrLoadModule("/e2e/benchmark-evidence-set.ts");
    if (args[0] === "--verify") {
      await evidence.verifyPromotedBenchmarkEvidenceSetV1(resolve(args[1]));
      console.log(`verified engine WebGPU evidence: ${resolve(args[1])}`);
    } else {
      const result = await evidence.promoteBenchmarkEvidenceSetV1({
        benchmarkPath: resolve(args[0]),
        stageTelemetryPath: resolve(args[2]),
        stressPath: resolve(args[1]),
      });
      console.log(`promoted engine WebGPU evidence: ${result.destination}`);
    }
  } finally {
    await vite.close();
  }
}
