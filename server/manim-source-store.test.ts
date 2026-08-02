import { execFile } from "node:child_process";
import { watch, writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "./http/json";
import { ManimSourceStore, sourceHash } from "./manim-source-store";

const temporaryRoots: string[] = [];

const mkfifo = async (path: string) => {
  await promisify(execFile)("mkfifo", [path]);
};

async function withFakePlatform<T>(platform: string, run: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("process.platform descriptor is missing.");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

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
        store.writeIfUnchanged("scene.py", sourceHash(source), candidate, "Source changed during commit."),
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

  it("does not publish a prepared write after its request is aborted", async () => {
    const { projectRoot, source, sourcePath } = await fixture();
    let allowCommit!: () => void;
    let reportPrepared!: () => void;
    const prepared = new Promise<void>((resolve) => {
      reportPrepared = resolve;
    });
    const commitAllowed = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const store = new ManimSourceStore(projectRoot, {
      beforeWriteCommit: async () => {
        reportPrepared();
        await commitAllowed;
      },
    });
    const controller = new AbortController();
    const write = store.writeIfUnchanged(
      "scene.py",
      sourceHash(source),
      "# stale rendered edit\n",
      "Conflict.",
      controller.signal,
    );

    await prepared;
    controller.abort();
    allowCommit();

    await expect(write).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(sourcePath, "utf8")).toBe(source);
  });

  it("does not overwrite an external edit made at the prepared-write boundary", async () => {
    const { projectRoot, source, sourcePath } = await fixture();
    const externalSource = "# changed while the rendered write was prepared\n";
    const store = new ManimSourceStore(projectRoot, {
      beforeWriteCommit: async () => {
        await writeFile(sourcePath, externalSource, "utf8");
      },
    });

    await expect(
      store.writeIfUnchanged("scene.py", sourceHash(source), "# stale rendered edit\n", "Conflict."),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(sourcePath, "utf8")).toBe(externalSource);
  });

  it("continues to reject symbolic-link sources", async () => {
    const { projectRoot, sourcePath, store } = await fixture();
    const linkedPath = join(projectRoot, "linked.py");
    await symlink(sourcePath, linkedPath);

    await expect(store.read("linked.py")).rejects.toThrow(/symbolic link/i);
    expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
  });
});

describe("ManimSourceStore.readVerified portability", () => {
  it("fails closed with 501 on platforms without descriptor verification", async () => {
    const { projectRoot } = await fixture();
    const store = new ManimSourceStore(projectRoot);
    await withFakePlatform("darwin", async () => {
      expect(ManimSourceStore.supportsVerifiedRead).toBe(false);
      await expect(store.readVerified("scene.py")).rejects.toMatchObject({ status: 501 });
    });
  });
});

describe.skipIf(!ManimSourceStore.supportsVerifiedRead)("ManimSourceStore.readVerified", () => {
  async function outsideFile(contents: string) {
    const outsideRoot = await mkdtemp(join(tmpdir(), "poietra-outside-"));
    temporaryRoots.push(outsideRoot);
    const path = join(outsideRoot, "outside.py");
    await writeFile(path, contents, "utf8");
    return { outsideRoot, path };
  }

  it("returns the same snapshot as read for an honest source", async () => {
    const { projectRoot, source } = await fixture();
    const store = new ManimSourceStore(projectRoot);
    const verified = await store.readVerified("scene.py");
    expect(verified.source).toBe(source);
    expect(verified.hash).toBe(sourceHash(source));
    expect(verified).toEqual(await store.read("scene.py"));
  });

  it("rejects a pathname swapped to a symlink between validation and open", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const { path: secretPath } = await outsideFile("# outside secret\n");
    const store = new ManimSourceStore(projectRoot, {
      beforeOpen: async () => {
        await rm(sourcePath);
        await symlink(secretPath, sourcePath);
      },
    });
    await expect(store.readVerified("scene.py")).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a pathname swapped to a FIFO between validation and open instead of blocking forever", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const store = new ManimSourceStore(projectRoot, {
      beforeOpen: async () => {
        await rm(sourcePath);
        // Without O_NONBLOCK this open would block until a writer appears,
        // pinning the request beyond every admission and timeout control.
        await mkfifo(sourcePath);
      },
    });
    // The vitest test deadline is the proof of settlement: a blocking open
    // would time the whole test out instead of rejecting deterministically.
    await expect(store.readVerified("scene.py")).rejects.toThrow(/regular file/i);
  }, 5_000);

  it("rejects a pathname swapped to an oversized file between validation and open", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const store = new ManimSourceStore(projectRoot, {
      beforeOpen: async () => {
        await writeFile(sourcePath, "#".padEnd(2 * 1024 * 1024 + 1, "x"), "utf8");
      },
    });
    await expect(store.readVerified("scene.py")).rejects.toThrow(/too large/i);
  });

  it("rejects a source renamed outside the project root after open", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const { outsideRoot } = await outsideFile("# placeholder\n");
    const store = new ManimSourceStore(projectRoot, {
      afterOpen: async () => {
        await rename(sourcePath, join(outsideRoot, "moved.py"));
      },
    });
    await expect(store.readVerified("scene.py")).rejects.toThrow(/outside the configured Manim project root/i);
  });

  it("rejects a source deleted after open instead of serving orphaned bytes", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const store = new ManimSourceStore(projectRoot, {
      afterOpen: async () => {
        await rm(sourcePath);
      },
    });
    await expect(store.readVerified("scene.py")).rejects.toThrow(/outside the configured Manim project root/i);
  });

  it("rejects invalid UTF-8 instead of replacing bytes and collapsing distinct sources to one hash", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const store = new ManimSourceStore(projectRoot);
    // Two distinct invalid-byte sequences that Buffer.toString('utf8') would
    // both fold to U+FFFD, collapsing their hashes; a fatal decode rejects
    // both as a sanitized 400 before any hash is computed.
    await writeFile(sourcePath, Buffer.from([0x70, 0x72, 0x69, 0x6e, 0x74, 0x80]));
    await expect(store.read("scene.py")).rejects.toMatchObject({ status: 400 });
    await expect(store.readVerified("scene.py")).rejects.toMatchObject({ status: 400 });
    await writeFile(sourcePath, Buffer.from([0x70, 0x72, 0x69, 0x6e, 0x74, 0xff]));
    await expect(store.read("scene.py")).rejects.toMatchObject({ status: 400 });
    await expect(store.readVerified("scene.py")).rejects.toMatchObject({ status: 400 });
  });

  it("preserves a leading UTF-8 BOM in source text and hashes", async () => {
    const source = "\ufefffrom manim import *\n";
    const { store } = await fixture(source);

    await expect(store.read("scene.py")).resolves.toMatchObject({ hash: sourceHash(source), source });
    await expect(store.readVerified("scene.py")).resolves.toMatchObject({ hash: sourceHash(source), source });
  });

  it("keeps a near-cap multibyte source under the byte budget without decode expansion", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const store = new ManimSourceStore(projectRoot);
    // A valid UTF-8 file just under the 2 MiB byte cap: an exact decode keeps
    // it under budget, where the old replacement decode of invalid bytes would
    // have expanded (three bytes per U+FFFD) and later overflowed downstream.
    const twoByteChar = "é"; // U+00E9 → 2 UTF-8 bytes
    const nearCap = twoByteChar.repeat((2 * 1024 * 1024) / 2 - 8);
    expect(Buffer.byteLength(nearCap, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    await writeFile(sourcePath, nearCap, "utf8");
    const readSource = await store.read("scene.py");
    expect(readSource.source).toBe(nearCap);
    const verified = await store.readVerified("scene.py");
    expect(verified.source).toBe(nearCap);
    expect(verified.hash).toBe(readSource.hash);
  });

  it("rejects a same-inode, same-length rewrite between read chunks", async () => {
    const bigSource = `# torn\n`.padEnd(150_000, "x");
    const { projectRoot } = await fixture(bigSource);
    let rewritten = false;
    const store = new ManimSourceStore(projectRoot, {
      afterChunk: async (absolutePath, chunkIndex) => {
        if (chunkIndex !== 0 || rewritten) return;
        rewritten = true;
        // Same inode, same byte length; the changed byte sits inside the
        // already-consumed first chunk, so the assembled bytes are torn and
        // must be rejected even when filesystem timestamp granularity makes
        // the before/after file versions indistinguishable.
        const replacement = Buffer.from(bigSource, "utf8");
        replacement[100] = 0x79;
        await writeFile(absolutePath, replacement);
      },
    });
    await expect(store.readVerified("scene.py")).rejects.toThrow(/changed while it was being read/i);
    expect(rewritten).toBe(true);
  });

  it("is not fooled by a decoy file named after the kernel's deleted-target suffix", async () => {
    const { projectRoot, sourcePath } = await fixture();
    const store = new ManimSourceStore(projectRoot, {
      afterOpen: async () => {
        await rm(sourcePath);
        // The /proc link target for the unlinked inode reads
        // "<sourcePath> (deleted)"; pre-creating that exact name inside the
        // root must not make the containment check vouch for orphaned bytes.
        await writeFile(`${sourcePath} (deleted)`, "# decoy\n", "utf8");
      },
    });
    await expect(store.readVerified("scene.py")).rejects.toThrow(/outside the configured Manim project root/i);
  });
});
