import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function runtimeTraceProducer() {
  const commandText = process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND?.trim();
  const repositoryText = process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY?.trim();
  if (!commandText || !repositoryText) {
    throw new Error(
      "Runtime Trace Cairo parity requires POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND and POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY.",
    );
  }
  let command: unknown;
  try {
    command = JSON.parse(commandText);
  } catch (error) {
    throw new Error("Runtime Trace Cairo parity requires the producer command as a JSON argv array.", { cause: error });
  }
  if (
    !Array.isArray(command) ||
    command.length !== 3 ||
    !command.every((argument) => typeof argument === "string" && argument.length > 0) ||
    command[1] !== "-m" ||
    command[2] !== "manim.renderer.runtime_trace"
  ) {
    throw new Error('Runtime Trace Cairo parity requires [python, "-m", "manim.renderer.runtime_trace"].');
  }
  return { python: command[0], repository: resolve(repositoryText) } as const;
}

export async function withGeneratedRuntimeTraceCairoReferenceV1<T>(
  input: Readonly<{
    generatorPath: string;
    read: (referenceRoot: string) => Promise<T>;
    temporaryPrefix: string;
  }>,
) {
  const producer = runtimeTraceProducer();
  const temporaryRoot = await mkdtemp(join(tmpdir(), input.temporaryPrefix));
  const referenceRoot = join(temporaryRoot, "reference");
  try {
    await execFile(
      producer.python,
      [resolve(input.generatorPath), "--fast-manim", producer.repository, "--output", referenceRoot],
      { env: { ...process.env, PYTHONHASHSEED: "0" }, maxBuffer: 2 * 1024 * 1024 },
    );
    return await input.read(referenceRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
