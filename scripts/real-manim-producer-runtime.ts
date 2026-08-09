import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type RealManimProducerToolchainProbe = Readonly<{
  manimFile?: unknown;
  manimVersion?: unknown;
  pythonVersion?: unknown;
}>;

export async function assertRealManimProducerRuntimeBinding({
  expectedManimVersion,
  expectedPythonVersion,
  producerRoot,
  pythonCommand,
  toolchain,
}: Readonly<{
  expectedManimVersion: string;
  expectedPythonVersion: string;
  producerRoot: string;
  pythonCommand: string;
  toolchain: RealManimProducerToolchainProbe;
}>): Promise<void> {
  const expectedPython = resolve(producerRoot, ".venv", "bin", "python");
  if (!isAbsolute(pythonCommand) || resolve(pythonCommand) !== expectedPython) {
    throw new Error(`The census producer must use the verified checkout Python at ${expectedPython}.`);
  }
  const pythonMetadata = await stat(expectedPython);
  if (!pythonMetadata.isFile()) throw new Error("The pinned census Python command is not a file.");
  if (toolchain.pythonVersion !== expectedPythonVersion || toolchain.manimVersion !== expectedManimVersion) {
    throw new Error(
      `Expected Python ${expectedPythonVersion} and Manim ${expectedManimVersion}, received Python ${String(toolchain.pythonVersion)} and Manim ${String(toolchain.manimVersion)}.`,
    );
  }
  if (typeof toolchain.manimFile !== "string" || !isAbsolute(toolchain.manimFile)) {
    throw new Error("The census producer did not report an absolute imported Manim module path.");
  }
  const [manimRoot, manimFile] = await Promise.all([
    realpath(join(producerRoot, "manim")),
    realpath(toolchain.manimFile),
  ]);
  const [manimRootMetadata, manimFileMetadata] = await Promise.all([stat(manimRoot), stat(manimFile)]);
  const importedRelativePath = relative(manimRoot, manimFile);
  if (
    !manimRootMetadata.isDirectory() ||
    !manimFileMetadata.isFile() ||
    importedRelativePath.length === 0 ||
    importedRelativePath === ".." ||
    importedRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(importedRelativePath)
  ) {
    throw new Error("The census Python environment did not import Manim from the verified producer checkout.");
  }
}
