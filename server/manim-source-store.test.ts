import { watch, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "./http/json";
import { ManimSourceStore, sourceHash } from "./manim-source-store";

const temporaryRoots: string[] = [];

async function fixture(source = "# original\n") {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-source-store-"));
  const sourcePath = join(projectRoot, "scene.py");
  temporaryRoots.push(projectRoot);
  await writeFile(sourcePath, source, "utf8");
  return { projectRoot, source, sourcePath, store: new ManimSourceStore(projectRoot) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ManimSourceStore", () => {
  it("does not overwrite an external edit made while a CAS write is being prepared", async () => {
    const { projectRoot, source, sourcePath, store } = await fixture();
    const externalSource = "# changed by an external editor\n";
    const candidate = "# rendered\n".padEnd(2 * 1024 * 1024, "x");
    const watcher = watch(projectRoot, { persistent: false });
    let editStarted = false;
    let resolveEdit!: () => void;
    let rejectEdit!: (error: unknown) => void;
    const externalEdit = new Promise<void>((resolve, reject) => {
      resolveEdit = resolve;
      rejectEdit = reject;
    });
    watcher.on("change", (_event, filename) => {
      if (editStarted || !filename?.toString().endsWith(".tmp")) return;
      editStarted = true;
      try {
        writeFileSync(sourcePath, externalSource, "utf8");
        resolveEdit();
      } catch (error) {
        rejectEdit(error);
      }
    });
    watcher.on("error", rejectEdit);

    try {
      const rejectedWrite = expect(
        store.writeIfUnchanged(
          "scene.py",
          sourceHash(source),
          candidate,
          "Source changed during commit.",
        ),
      ).rejects.toMatchObject({ status: 409 });
      await externalEdit;

      await rejectedWrite;
      expect(await readFile(sourcePath, "utf8")).toBe(externalSource);
    } finally {
      watcher.close();
    }
  });

  it("serializes CAS writes through one store", async () => {
    const { source, sourcePath, store } = await fixture();
    const writes = await Promise.allSettled([
      store.writeIfUnchanged("scene.py", sourceHash(source), "# first\n", "Conflict."),
      store.writeIfUnchanged("scene.py", sourceHash(source), "# second\n", "Conflict."),
    ]);

    expect(writes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = writes.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(HttpError);
    expect((rejected as PromiseRejectedResult).reason.status).toBe(409);
    expect(["# first\n", "# second\n"]).toContain(await readFile(sourcePath, "utf8"));
  });

  it("preserves the source file mode when replacing its contents", async () => {
    const { source, sourcePath, store } = await fixture();
    await chmod(sourcePath, 0o640);

    await store.writeIfUnchanged("scene.py", sourceHash(source), "# committed\n", "Conflict.");

    expect((await stat(sourcePath)).mode & 0o777).toBe(0o640);
  });

  it("continues to reject symbolic-link sources", async () => {
    const { projectRoot, sourcePath, store } = await fixture();
    const linkedPath = join(projectRoot, "linked.py");
    await symlink(sourcePath, linkedPath);

    await expect(store.read("linked.py")).rejects.toThrow(/symbolic link/i);
    expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
  });
});
