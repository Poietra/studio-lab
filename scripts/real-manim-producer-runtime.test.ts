import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertRealManimProducerRuntimeBinding } from "./real-manim-producer-runtime";

async function withProducerFixture(
  callback: (
    fixture: Readonly<{ manimFile: string; producerRoot: string; python: string; siblingManim: string }>,
  ) => Promise<void>,
) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-producer-runtime-"));
  const producerRoot = join(temporaryRoot, "fast-manim");
  const python = join(producerRoot, ".venv", "bin", "python");
  const manimFile = join(producerRoot, "manim", "__init__.py");
  const siblingManim = join(temporaryRoot, "unverified", "manim", "__init__.py");
  try {
    await Promise.all([
      mkdir(join(producerRoot, ".venv", "bin"), { recursive: true }),
      mkdir(join(producerRoot, "manim"), { recursive: true }),
      mkdir(join(temporaryRoot, "unverified", "manim"), { recursive: true }),
    ]);
    await Promise.all([writeFile(python, "python"), writeFile(manimFile, "manim"), writeFile(siblingManim, "manim")]);
    await callback({ manimFile, producerRoot, python, siblingManim });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

const versions = { expectedManimVersion: "0.20.1", expectedPythonVersion: "3.13.11" } as const;

describe("real Manim producer runtime binding", () => {
  it("accepts the exact checkout Python when it imports the verified checkout module", async () => {
    await withProducerFixture(async ({ manimFile, producerRoot, python }) => {
      await expect(
        assertRealManimProducerRuntimeBinding({
          ...versions,
          producerRoot,
          pythonCommand: python,
          toolchain: { manimFile, manimVersion: "0.20.1", pythonVersion: "3.13.11" },
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects a different Python command, an external Manim module, and version drift", async () => {
    await withProducerFixture(async ({ manimFile, producerRoot, python, siblingManim }) => {
      await expect(
        assertRealManimProducerRuntimeBinding({
          ...versions,
          producerRoot,
          pythonCommand: join(producerRoot, "other", "python"),
          toolchain: { manimFile, manimVersion: "0.20.1", pythonVersion: "3.13.11" },
        }),
      ).rejects.toThrow("verified checkout Python");
      await expect(
        assertRealManimProducerRuntimeBinding({
          ...versions,
          producerRoot,
          pythonCommand: python,
          toolchain: { manimFile: siblingManim, manimVersion: "0.20.1", pythonVersion: "3.13.11" },
        }),
      ).rejects.toThrow("did not import Manim from the verified producer checkout");
      await expect(
        assertRealManimProducerRuntimeBinding({
          ...versions,
          producerRoot,
          pythonCommand: python,
          toolchain: { manimFile, manimVersion: "0.20.1", pythonVersion: "3.12.0" },
        }),
      ).rejects.toThrow("Expected Python 3.13.11 and Manim 0.20.1");
    });
  });
});
