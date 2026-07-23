import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { electronPackageLayout } from "./electron-package-layout.mjs";

const repositoryRoot = resolve(process.cwd());
const runtimeRoot = resolve(repositoryRoot, "node_modules", "electron", "dist");
const layout = electronPackageLayout(repositoryRoot);
const outputRelative = relative(repositoryRoot, layout.outputRoot);
if (!outputRelative.startsWith(`release${sep}`)) {
  throw new Error("Electron package output must stay inside the repository release directory.");
}

await rm(layout.outputRoot, { force: true, recursive: true });
await mkdir(dirname(layout.outputRoot), { recursive: true });
await cp(runtimeRoot, layout.outputRoot, { recursive: true, verbatimSymlinks: true });
await mkdir(layout.appRoot, { recursive: true });
await Promise.all([
  cp(resolve(repositoryRoot, "dist"), resolve(layout.appRoot, "dist"), { recursive: true }),
  cp(resolve(repositoryRoot, "dist-electron"), resolve(layout.appRoot, "dist-electron"), { recursive: true }),
  mkdir(resolve(layout.appRoot, "electron"), { recursive: true })
    .then(() => cp(
      resolve(repositoryRoot, "electron", "preload.cjs"),
      resolve(layout.appRoot, "electron", "preload.cjs"),
    )),
]);
await writeFile(resolve(layout.appRoot, "package.json"), `${JSON.stringify({
  main: "dist-electron/app-main.mjs",
  name: "poietra-studio-lab",
  private: true,
  type: "module",
  version: "0.0.0",
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ executable: layout.executable, outputRoot: layout.outputRoot })}\n`);
