import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
if (args.length !== 2) {
  console.error("Usage: pnpm evidence:manim-compositor:promote -- <source-directory> <destination-directory>");
  console.error("   or: pnpm evidence:manim-compositor:verify -- <evidence-directory>");
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
    const evidence = await vite.ssrLoadModule("/e2e/manim-compositor-parity-evidence.ts");
    if (args[0] === "--verify") {
      const directory = resolve(args[1]);
      await evidence.verifyManimCompositorParityEvidenceV1(directory);
      console.log(`verified Manim compositor parity evidence: ${directory}`);
    } else {
      const promoted = await evidence.promoteManimCompositorParityEvidenceV1({
        destinationDirectory: resolve(args[1]),
        sourceDirectory: resolve(args[0]),
      });
      console.log(`promoted Manim compositor parity evidence: ${promoted.destination}`);
    }
  } finally {
    await vite.close();
  }
}
