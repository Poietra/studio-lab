import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { manimWorkspaceViewSchema } from "../src/render-pipeline/contracts";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { createTrustedLocalManimRequestContext } from "./manim-local-request-context";
import { PersistentManimProjectCatalog } from "./manim-project-catalog";
import { ManimProjectRegistry } from "./manim-project-registry";
import { handleManimRequest } from "./manim-render-http";
import {
  cleanupManimRenderPipelineFixtures,
  commitRequest,
  fakeRenderer,
  registryFixture,
  request,
  sceneSource,
  temporaryRoots,
  waitForTerminal,
} from "./manim-render-pipeline-test-fixtures";

const projectPngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(cleanupManimRenderPipelineFixtures);

describe("Manim project registry", () => {
  it("lists configured projects without exposing their filesystem roots", async () => {
    const { firstRoot, registry, secondRoot } = await registryFixture();

    const projects = registry.projects();
    expect(projects).toEqual({
      defaultProjectId: "project-a",
      projects: [
        { id: "project-a", kind: "existing", name: "Project A" },
        { id: "project-b", kind: "existing", name: "Project B" },
      ],
    });
    expect(JSON.stringify(projects)).not.toContain(firstRoot);
    expect(JSON.stringify(projects)).not.toContain(secondRoot);
    const workspace = await registry.workspace("project-b");
    expect(workspace).toMatchObject({
      projectId: "project-b",
      projectName: "Project B",
    });
    expect("nativeDocument" in workspace).toBe(false);
    expect(() => registry.workspace("missing-project")).toThrow(/project not found/i);
  });

  it("routes digest-addressed snapshot assets through the owning project", async () => {
    const { firstRoot, registry } = await registryFixture();
    await writeFile(join(firstRoot, "image.png"), projectPngBytes);
    const digest = createHash("sha256").update(projectPngBytes).digest("hex");

    const asset = await registry.sceneSnapshotAsset("project-a", digest);
    expect(asset).toMatchObject({ digest, mediaType: "image/png" });
    expect(Buffer.from(asset.body)).toEqual(projectPngBytes);
    await expect(registry.sceneSnapshotAsset("project-a", "f".repeat(64))).rejects.toMatchObject({ status: 404 });
    expect(() => registry.sceneSnapshotAsset("missing-project", digest)).toThrow(/project not found/i);
  });

  it("persists create, rename, and unregister without deleting source folders", async () => {
    const { dataRoot, firstRoot, registry, secondRoot } = await registryFixture(
      ["poietra-command-that-does-not-exist"],
      true,
    );
    const thirdRoot = await mkdtemp(join(tmpdir(), "poietra-project-c-"));
    temporaryRoots.push(thirdRoot);
    await writeFile(join(thirdRoot, "scene.py"), sceneSource, "utf8");

    const created = registry.createProject("Project C", thirdRoot);
    const projectId = created.project?.id;
    expect(projectId).toMatch(/^project-[0-9a-f]{16}$/);
    expect(created.catalog.projects).toContainEqual({ id: projectId, kind: "existing", name: "Project C" });
    if (!projectId) throw new Error("The created project ID is missing.");

    expect(registry.renameProject(projectId, "Renamed C").project).toEqual({
      id: projectId,
      kind: "existing",
      name: "Renamed C",
    });
    await registry.unregisterProject("project-a");
    await registry.unregisterProject("project-b");
    const emptied = await registry.unregisterProject(projectId);

    expect(emptied).toEqual({ catalog: { defaultProjectId: null, projects: [] }, project: null });
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    expect(await readFile(join(secondRoot, "scene.py"), "utf8")).toBe(sceneSource);
    expect(await readFile(join(thirdRoot, "scene.py"), "utf8")).toBe(sceneSource);
    const reopened = new PersistentManimProjectCatalog({
      dataRoot: dataRoot!,
      seedProjects: [{ id: "ignored-seed", name: "Ignored", root: firstRoot }],
    });
    expect(reopened.projects()).toEqual([]);
    expect(() => registry.workspace()).toThrow(/no Manim workspace/i);
  });

  it("creates a browser-managed workspace with an importable starter Scene", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);

    const created = registry.createManagedProject("Browser workspace");
    const projectId = created.project?.id;
    expect(projectId).toMatch(/^project-[0-9a-f]{32}$/);
    if (!projectId) throw new Error("The managed project ID is missing.");
    const managedRoot = join(dataRoot!, ".workspaces", projectId);
    expect(await readFile(join(managedRoot, "main.py"), "utf8")).toContain("class MainScene(Scene)");
    await expect(registry.workspace(projectId)).resolves.toMatchObject({
      projectId,
      projectName: "Browser workspace",
      sources: [{ path: "main.py", scenes: [{ anchors: [0], name: "MainScene" }] }],
    });
    const persisted = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(persisted.projects()).toContainEqual(
      expect.objectContaining({
        canonicalRoot: managedRoot,
        kind: "managed",
        projectId,
      }),
    );

    await registry.unregisterProject(projectId);
    await expect(readFile(join(managedRoot, "main.py"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const trashEntries = await readdir(join(dataRoot!, ".trash"));
    expect(trashEntries).toHaveLength(1);
    expect(trashEntries[0]).toMatch(new RegExp(`^${projectId}-[0-9a-f-]{36}$`));
    expect(await readFile(join(dataRoot!, ".trash", trashEntries[0]!, "main.py"), "utf8")).toContain(
      "poietra:anchor 0.000",
    );
    const reopened = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(reopened.projects().some((project) => project.projectId === projectId)).toBe(false);
  });

  it("creates and reopens a source-free local Studio-native workspace", async () => {
    const command = ["poietra-command-that-does-not-exist"];
    const { dataRoot, registry } = await registryFixture(command, true);

    const created = registry.createNativeStudioProject("Blank canvas");
    const projectId = created.project?.id;
    if (!projectId) throw new Error("The Studio-native project ID is missing.");
    const managedRoot = join(dataRoot!, ".workspaces", projectId);
    const documentKey = (await readFile(join(managedRoot, ".poietra-native-document"), "utf8")).trim();

    expect(documentKey).toMatch(/^[0-9a-f]{64}$/u);
    expect((await stat(join(managedRoot, ".poietra-native-document"))).mode & 0o777).toBe(0o600);
    expect((await readdir(managedRoot)).some((entry) => entry.endsWith(".py"))).toBe(false);
    await expect(registry.workspace(projectId)).resolves.toEqual({
      commandAvailable: false,
      frame: { height: 8, width: 14.222 },
      nativeDocument: { documentKey },
      projectId,
      projectName: "Blank canvas",
      renderCapability: {
        available: false,
        kind: "local-command",
        unavailableReason: "native-render-frozen",
      },
      sources: [],
    });

    const reopenedCatalog = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(reopenedCatalog.projects()).toContainEqual(
      expect.objectContaining({ nativeDocumentKey: documentKey, projectId }),
    );
    const reopenedRegistry = new ManimProjectRegistry({
      catalog: reopenedCatalog,
      catalogStorageRoot: dataRoot!,
      command,
      frame: { height: 8, width: 14.222 },
      projects: [],
      tenantId: "test-tenant",
    });
    try {
      await expect(reopenedRegistry.workspace(projectId)).resolves.toMatchObject({
        nativeDocument: { documentKey },
        renderCapability: { available: false, unavailableReason: "native-render-frozen" },
        sources: [],
      });
    } finally {
      await reopenedRegistry.close();
    }

    await registry.unregisterProject(projectId);
    await expect(stat(managedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const trashedRoot = (await readdir(join(dataRoot!, ".trash"))).find((entry) => entry.startsWith(`${projectId}-`));
    if (!trashedRoot) throw new Error("The removed Studio-native workspace is missing from trash.");
    await expect(readFile(join(dataRoot!, ".trash", trashedRoot, ".poietra-native-document"), "utf8")).resolves.toBe(
      `${documentKey}\n`,
    );
  });

  it("keeps a committed native workspace deletion successful when runtime cleanup rejects", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-native-delete-cleanup-"));
    temporaryRoots.push(dataRoot);
    const records: StructuredLogRecord[] = [];
    const catalog = new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
    const registry = new ManimProjectRegistry({
      catalog,
      catalogStorageRoot: dataRoot,
      command: ["poietra-command-that-does-not-exist"],
      frame: { height: 8, width: 14.222 },
      logger: createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] }),
      projects: [],
      snapshotSandboxBackendFactory: () => ({
        async close() {
          throw new Error("backend cleanup failed");
        },
        start() {
          throw new Error("not used");
        },
        async status() {
          return {};
        },
      }),
      tenantId: "test-tenant",
    });
    try {
      const projectId = registry.createNativeStudioProject("Cleanup failure").project?.id;
      if (!projectId) throw new Error("The Studio-native project ID is missing.");

      await expect(registry.unregisterProject(projectId)).resolves.toEqual({
        catalog: { defaultProjectId: null, projects: [] },
        project: null,
      });
      expect(catalog.projects()).toEqual([]);
      expect((await readdir(join(dataRoot, ".trash"))).some((entry) => entry.startsWith(`${projectId}-`))).toBe(true);
      expect(records).toContainEqual(
        expect.objectContaining({
          data: { cleanupFailures: 1, projectId },
          event: "project.unregister_cleanup_failed",
          level: "error",
        }),
      );
    } finally {
      await registry.close();
    }
  });

  it("quarantines invalid local native markers instead of reopening them as imported workspaces", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const malformed = registry.createNativeStudioProject("Malformed marker").project?.id;
    const dangling = registry.createNativeStudioProject("Dangling marker").project?.id;
    if (!malformed || !dangling) throw new Error("The Studio-native project IDs are missing.");
    const malformedMarker = join(dataRoot!, ".workspaces", malformed, ".poietra-native-document");
    const danglingMarker = join(dataRoot!, ".workspaces", dangling, ".poietra-native-document");
    await writeFile(malformedMarker, "not-a-document-key\n", "utf8");
    await rm(danglingMarker);
    await symlink("missing-document-key", danglingMarker);

    const reopened = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(reopened.projects().some((project) => project.projectId === malformed)).toBe(false);
    expect(reopened.projects().some((project) => project.projectId === dangling)).toBe(false);
  });

  it("rolls back native workspace publication when its render manager cannot be created", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-native-manager-failure-"));
    temporaryRoots.push(dataRoot);
    const catalog = new PersistentManimProjectCatalog({
      dataRoot,
      projectIdFactory: () => "project-native-manager-failure",
      seedProjects: [],
    });
    const registry = new ManimProjectRegistry({
      catalog,
      catalogStorageRoot: dataRoot,
      command: ["poietra-command-that-does-not-exist"],
      frame: { height: 8, width: 14.222 },
      projects: [],
      snapshotSandboxBackendFactory: () => {
        throw new Error("manager construction failed");
      },
      tenantId: "test-tenant",
    });
    try {
      expect(() => registry.createNativeStudioProject("Rollback me")).toThrow(/manager construction failed/i);
      expect(catalog.projects()).toEqual([]);
      expect(await readdir(join(dataRoot, ".workspaces"))).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it("publishes a browser-selected Python file through the local managed adapter under one project identity", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const source =
      "from manim import *\nclass ImportedScene(Scene):\n    def construct(self):\n        circle = Circle()\n        self.add(circle)\n";

    const imported = registry.importBrowserProject({
      imagePngBase64: null,
      name: "Imported browser workspace",
      source,
      sourceName: "lesson.py",
    });
    const projectId = imported.project?.id;
    if (!projectId) throw new Error("The imported project ID is missing.");
    const managedRoot = join(dataRoot!, ".workspaces", projectId);

    expect(imported.project).toEqual({ id: projectId, kind: "managed", name: "Imported browser workspace" });
    expect(await readFile(join(managedRoot, "lesson.py"), "utf8")).toBe(source);
    const workspace = await registry.workspace(projectId);
    expect(workspace).toMatchObject({
      projectId,
      projectName: "Imported browser workspace",
      sources: [{ path: "lesson.py", scenes: [{ name: "ImportedScene" }] }],
    });
    await expect(
      registry.exportOriginalSource({
        projectId,
        sourceHash: createHash("sha256").update(source).digest("hex"),
        sourcePath: "lesson.py",
      }),
    ).resolves.toEqual({ fileName: "lesson.py", projectId, source });
    expect(new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] }).projects()).toContainEqual(
      expect.objectContaining({ canonicalRoot: managedRoot, kind: "managed", projectId }),
    );
  });

  it("rejects unsupported browser imports before allocating a local managed workspace", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);

    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: null,
        name: "No Scene",
        source: "print('hello')\n",
        sourceName: "script.py",
      }),
    ).toThrow(/does not contain an importable Manim Scene/i);
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: null,
        name: "Asset Scene",
        source:
          'from manim import *\nclass AssetScene(Scene):\n    def construct(self):\n        image = ImageMobject("asset.png")\n        self.add(image)\n',
        sourceName: "asset_scene.py",
      }),
    ).toThrow(/only direct ImageMobject assignments with literal "image[.]png"/i);
    expect(await readdir(join(dataRoot!, ".workspaces"))).toEqual([]);
  });

  it("writes one validated browser image.png privately beside its source", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const source = `from manim import *
class ImageScene(Scene):
    def construct(self):
        image = ImageMobject(filename_or_array="image.png")
        self.add(image)
`;

    const imported = registry.importBrowserProject({
      imagePngBase64: projectPngBytes.toString("base64"),
      name: "Image browser workspace",
      source,
      sourceName: "image_scene.py",
    });
    const projectId = imported.project?.id;
    if (!projectId) throw new Error("The imported project ID is missing.");
    const managedRoot = join(dataRoot!, ".workspaces", projectId);

    expect(await readFile(join(managedRoot, "image_scene.py"), "utf8")).toBe(source);
    expect(await readFile(join(managedRoot, "image.png"))).toEqual(projectPngBytes);
    expect((await stat(join(managedRoot, "image.png"))).mode & 0o777).toBe(0o600);
    await expect(registry.workspace(projectId)).resolves.toMatchObject({
      projectId,
      sources: [{ path: "image_scene.py", scenes: [{ name: "ImageScene" }] }],
    });
  });

  it("rejects missing, unused, dynamic, and malformed browser image.png inputs before publication", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const imageSource = (filename: string) => `from manim import *
class ImageScene(Scene):
    def construct(self):
        image = ImageMobject(${filename})
        self.add(image)
`;
    const plainSource = `from manim import *
class PlainScene(Scene):
    def construct(self):
        self.add(Circle())
`;

    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: null,
        name: "Missing image",
        source: imageSource('"image.png"'),
        sourceName: "scene.py",
      }),
    ).toThrow(/select that PNG/i);
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: projectPngBytes.toString("base64"),
        name: "Unused image",
        source: plainSource,
        sourceName: "scene.py",
      }),
    ).toThrow(/not referenced/i);
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: projectPngBytes.toString("base64"),
        name: "Dynamic image",
        source: imageSource("asset_path"),
        sourceName: "scene.py",
      }),
    ).toThrow(/only direct ImageMobject assignments/i);
    for (const source of [
      `from manim import ImageMobject as Picture, Scene
class AliasImageScene(Scene):
    def construct(self):
        image = Picture("other.png")
`,
      `from manim import *
class ReboundImageScene(Scene):
    def construct(self):
        Picture = ImageMobject
        image = Picture("other.png")
`,
      `from manim import *
class FStringImageScene(Scene):
    def construct(self):
        detail = f"{ImageMobject('other.png')}"
`,
    ]) {
      expect(() =>
        registry.importBrowserProject({
          imagePngBase64: null,
          name: "Indirect image",
          source,
          sourceName: "scene.py",
        }),
      ).toThrow(/only direct ImageMobject assignments/i);
    }
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: projectPngBytes.toString("base64"),
        name: "Unreachable image",
        source: `from manim import *
class UnreachableImageScene(Scene):
    def construct(self):
        return
        image = ImageMobject("image.png")
`,
        sourceName: "scene.py",
      }),
    ).toThrow(/reachable direct ImageMobject assignment/i);
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: projectPngBytes.toString("base64"),
        name: "Inline image",
        source: `from manim import *
class InlineImageScene(Scene):
    def construct(self):
        self.add(ImageMobject("image.png"))
`,
        sourceName: "scene.py",
      }),
    ).toThrow(/only direct ImageMobject assignments/i);
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: `${projectPngBytes.toString("base64")}=`,
        name: "Noncanonical image",
        source: imageSource('"image.png"'),
        sourceName: "scene.py",
      }),
    ).toThrow(/canonical base64/i);
    expect(() =>
      registry.importBrowserProject({
        imagePngBase64: Buffer.from("not a png", "utf8").toString("base64"),
        name: "Invalid image",
        source: imageSource('"image.png"'),
        sourceName: "scene.py",
      }),
    ).toThrow(/image[.]png.*(?:truncated|signature)/i);
    expect(await readdir(join(dataRoot!, ".workspaces"))).toEqual([]);
  });

  it("does not delete an existing managed directory when ID allocation collides", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-managed-collision-"));
    temporaryRoots.push(dataRoot);
    const catalog = new PersistentManimProjectCatalog({
      dataRoot,
      projectIdFactory: () => "project-fixed",
      seedProjects: [],
    });
    const existingRoot = join(dataRoot, ".workspaces", "project-fixed");
    await mkdir(existingRoot);
    const existingSource = "# pre-existing source\n";
    await writeFile(join(existingRoot, "main.py"), existingSource, "utf8");

    expect(() => catalog.createManaged("Collision")).toThrow();
    expect(await readFile(join(existingRoot, "main.py"), "utf8")).toBe(existingSource);
    expect(catalog.projects()).toEqual([]);
  });

  it("migrates the existing version-one catalog as non-managed workspaces", async () => {
    const { dataRoot, firstRoot, secondRoot } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    await writeFile(
      join(dataRoot!, "workspace-catalog.json"),
      JSON.stringify({
        projects: [
          { id: "project-a", name: "Project A", root: firstRoot },
          { id: "project-b", name: "Project B", root: secondRoot },
        ],
        version: 1,
      }),
      "utf8",
    );

    const migrated = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(migrated.projects().map((project) => project.kind)).toEqual(["existing", "existing"]);
    migrated.rename("project-a", "Migrated A");
    const stored = JSON.parse(await readFile(join(dataRoot!, "workspace-catalog.json"), "utf8")) as {
      projects: { kind: string }[];
      version: number;
    };
    expect(stored.version).toBe(2);
    expect(stored.projects.map((project) => project.kind)).toEqual(["existing", "existing"]);
  });

  it("quarantines version-two managed entries outside the managed root or whose directory does not match the ID", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-invalid-managed-catalog-"));
    const validExistingRoot = await mkdtemp(join(tmpdir(), "poietra-valid-existing-"));
    temporaryRoots.push(dataRoot, validExistingRoot);
    new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
    const outsideManagedRoot = join(dataRoot, "outside-managed");
    const mismatchedManagedRoot = join(dataRoot, ".workspaces", "project-other-directory");
    await Promise.all([
      mkdir(outsideManagedRoot),
      mkdir(mismatchedManagedRoot),
      writeFile(join(validExistingRoot, "scene.py"), sceneSource, "utf8"),
    ]);
    await Promise.all([
      writeFile(join(outsideManagedRoot, "main.py"), sceneSource, "utf8"),
      writeFile(join(mismatchedManagedRoot, "main.py"), sceneSource, "utf8"),
    ]);
    await writeFile(
      join(dataRoot, "workspace-catalog.json"),
      JSON.stringify({
        projects: [
          {
            id: "project-outside",
            kind: "managed",
            name: "Outside managed root",
            root: outsideManagedRoot,
          },
          {
            id: "project-mismatch",
            kind: "managed",
            name: "Mismatched managed root",
            root: mismatchedManagedRoot,
          },
        ],
        version: 2,
      }),
      "utf8",
    );

    const catalog = new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
    expect(catalog.projects()).toEqual([]);
    expect(() => catalog.create("Outside as existing", outsideManagedRoot)).toThrow(/already registered/i);
    catalog.create("Valid existing", validExistingRoot);
    const persisted = JSON.parse(await readFile(join(dataRoot, "workspace-catalog.json"), "utf8")) as {
      projects: { id: string }[];
      version: number;
    };
    expect(persisted.version).toBe(2);
    expect(persisted.projects.map((project) => project.id)).toEqual(
      expect.arrayContaining(["project-outside", "project-mismatch"]),
    );
  });

  it("refuses to unregister a workspace with a retained render session", async () => {
    const { registry } = await registryFixture([process.execPath, fakeRenderer], true);
    const started = await registry.start({ ...request(), projectId: "project-a" });
    expect((await waitForTerminal(registry, started.id)).status).toBe("ready");

    await expect(registry.unregisterProject("project-a")).rejects.toThrow(/retained render sessions/i);

    await registry.discard(started.id);
    await expect(registry.unregisterProject("project-a")).resolves.toMatchObject({ project: null });
  });

  it("quarantines a persisted workspace while its folder is unavailable", async () => {
    const { dataRoot, firstRoot, secondRoot } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const movedRoot = `${secondRoot}-moved`;
    temporaryRoots.push(movedRoot);
    await rename(secondRoot, movedRoot);
    let restoredRoot = false;
    let quarantined: PersistentManimProjectCatalog | null = null;
    try {
      quarantined = new PersistentManimProjectCatalog({
        dataRoot: dataRoot!,
        seedProjects: [],
      });
      expect(quarantined.projects().map((project) => project.canonicalRoot)).toEqual([firstRoot]);
      quarantined.rename("project-a", "Renamed while B is unavailable");
      await rename(movedRoot, secondRoot);
      restoredRoot = true;
      expect(() => quarantined!.create("Duplicate B", secondRoot)).toThrow(/already registered/i);
    } finally {
      if (!restoredRoot) await rename(movedRoot, secondRoot);
    }
    const restored = new PersistentManimProjectCatalog({
      dataRoot: dataRoot!,
      seedProjects: [],
    });
    expect(restored.projects().map((project) => project.canonicalRoot)).toEqual([firstRoot, secondRoot]);
    expect(restored.projects().map((project) => project.projectName)).toEqual([
      "Renamed while B is unavailable",
      "Project B",
    ]);
  });

  it("quarantines a persisted workspace whose root resolves to another registration", async () => {
    const { dataRoot, firstRoot, secondRoot } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    await rm(secondRoot, { recursive: true });
    await symlink(firstRoot, secondRoot, "dir");

    const conflicted = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(conflicted.projects().map((project) => project.projectId)).toEqual(["project-a"]);
    conflicted.rename("project-a", "Renamed while B conflicts");

    await rm(secondRoot);
    await mkdir(secondRoot);
    await writeFile(join(secondRoot, "scene.py"), sceneSource, "utf8");
    const restored = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(restored.projects().map((project) => project.projectId)).toEqual(["project-a", "project-b"]);
    expect(restored.projects()[0]?.projectName).toBe("Renamed while B conflicts");
  });

  it("counts quarantined workspaces toward the catalog limit", async () => {
    const roots = await Promise.all(
      Array.from({ length: 65 }, () => mkdtemp(join(tmpdir(), "poietra-project-limit-"))),
    );
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-project-limit-catalog-"));
    temporaryRoots.push(...roots, dataRoot);
    new PersistentManimProjectCatalog({
      dataRoot,
      seedProjects: roots.slice(0, 64).map((root, index) => ({
        id: `project-limit-${index}`,
        name: `Project ${index}`,
        root,
      })),
    });
    const unavailableRoot = roots[63]!;
    const movedRoot = `${unavailableRoot}-moved`;
    await rename(unavailableRoot, movedRoot);
    try {
      const catalog = new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
      expect(catalog.projects()).toHaveLength(63);
      expect(() => catalog.create("One too many", roots[64]!)).toThrow(/at most 64/i);
    } finally {
      await rename(movedRoot, unavailableRoot);
    }

    expect(new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] }).projects()).toHaveLength(64);
  });

  it("lowers an exact Python export without requiring a working Manim command", async () => {
    const { firstRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"]);

    const exported = await registry.exportSource({ ...request(), projectId: "project-a" });

    expect(exported).toMatchObject({
      fileName: "scene.poietra.py",
      projectId: "project-a",
    });
    expect(exported.source).toContain('poietra:transaction "render-integration"');
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    await expect(registry.start({ ...request(), projectId: "project-a" })).rejects.toThrow(/unavailable/i);
  });

  it("exports the unchanged selected Python file without an EditProgram", async () => {
    const { firstRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"]);
    const sourceHash = createHash("sha256").update(sceneSource).digest("hex");

    const exported = await registry.exportOriginalSource({
      projectId: "project-a",
      sourceHash,
      sourcePath: "scene.py",
    });

    expect(exported).toEqual({
      fileName: "scene.py",
      projectId: "project-a",
      source: sceneSource,
    });
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    await expect(
      registry.exportOriginalSource({
        projectId: "project-a",
        sourceHash: "0".repeat(64),
        sourcePath: "scene.py",
      }),
    ).rejects.toThrow(/source changed before export/i);
  });

  it("routes Commit and Undo to the session's original project after another workspace is opened", async () => {
    const { firstRoot, registry, secondRoot } = await registryFixture();
    const started = await registry.start({ ...request(), projectId: "project-a" });
    await registry.workspace("project-b");
    expect((await waitForTerminal(registry, started.id)).status).toBe("ready");

    const committed = await registry.commit(started.id, commitRequest(started));
    expect(committed).toMatchObject({ projectId: "project-a", status: "committed" });
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toContain('poietra:transaction "render-integration"');
    expect(await readFile(join(secondRoot, "scene.py"), "utf8")).toBe(sceneSource);

    await registry.undo(started.id, "00000000-0000-4000-8000-000000000002");
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("prunes the registry session index when a project manager expires a session", async () => {
    const { registry } = await registryFixture();
    const started = await registry.start({ ...request(), projectId: "project-a" });
    const rendered = await waitForTerminal(registry, started.id);
    const internals = registry as unknown as { sessionProjects: Map<string, string> };
    expect(internals.sessionProjects.get(started.id)).toBe("project-a");

    await registry.cleanupExpiredSessions(Date.parse(rendered.updatedAt) + 30 * 60 * 1_000);

    expect(internals.sessionProjects.has(started.id)).toBe(false);
    expect(() => registry.view(started.id)).toThrow(/session not found/i);
  });

  it("rejects cross-origin JSON mutations before they can execute or change project source", async () => {
    const { firstRoot, registry } = await registryFixture();
    const started = await registry.start({ ...request(), projectId: "project-a" });
    await waitForTerminal(registry, started.id);
    const server = createServer((incoming, response) => {
      void handleManimRequest(createTrustedLocalManimRequestContext(registry, "test"), incoming, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      for (const endpoint of ["/api/manim/projects/project-a/renders", "/api/manim/renders"]) {
        const rejected = await fetch(`${origin}${endpoint}`, {
          body: JSON.stringify({ ...request(), projectId: "project-a" }),
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          method: "POST",
        });
        expect(rejected.status).toBe(403);
      }
      const simpleRequest = await fetch(`${origin}/api/manim/projects/project-a/renders`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "text/plain" },
        method: "POST",
      });
      expect(simpleRequest.status).toBe(415);

      for (const [endpoint, method, body] of [
        ["/api/manim/projects", "POST", { kind: "managed", name: "Cross-origin" }],
        ["/api/manim/projects/project-a", "PATCH", { name: "Cross-origin" }],
        ["/api/manim/projects/project-b", "DELETE", {}],
      ] as const) {
        const rejected = await fetch(`${origin}${endpoint}`, {
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          method,
        });
        expect(rejected.status).toBe(403);
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/manim/renders/${started.id}/commit`, {
        body: JSON.stringify(commitRequest(started)),
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        method: "POST",
      });

      expect(response.status).toBe(403);
      for (const [action, body] of [
        ["abandon", { renderRequestId: started.renderRequestId }],
        ["cancel-source-action", { actionId: "00000000-0000-4000-8000-000000000021", kind: "commit" }],
      ] as const) {
        const rejected = await fetch(`http://127.0.0.1:${address.port}/api/manim/renders/${started.id}/${action}`, {
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          method: "POST",
        });
        expect(rejected.status).toBe(403);
      }
      expect(registry.view(started.id).status).toBe("ready");
      expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves project discovery and a safe Python attachment over HTTP", async () => {
    const privateCommandRoot = await mkdtemp(join(tmpdir(), "poietra-private-command-"));
    temporaryRoots.push(privateCommandRoot);
    const privateCommandPath = join(privateCommandRoot, "bin", "manim");
    const privateCommandArgument = "--private-adapter-path";
    const { registry } = await registryFixture([privateCommandPath, privateCommandArgument]);
    const server = createServer((incoming, response) => {
      void handleManimRequest(createTrustedLocalManimRequestContext(registry, "test"), incoming, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const projectsResponse = await fetch(`${origin}/api/manim/projects`);
      expect(await projectsResponse.json()).toEqual(registry.projects());

      const exportResponse = await fetch(`${origin}/api/manim/projects/project-a/export`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get("content-type")).toBe("text/x-python; charset=utf-8");
      expect(exportResponse.headers.get("content-disposition")).toBe('attachment; filename="scene.poietra.py"');
      expect(await exportResponse.text()).toContain('poietra:transaction "render-integration"');

      const originalExportResponse = await fetch(`${origin}/api/manim/projects/project-a/export`, {
        body: JSON.stringify({
          projectId: "project-a",
          sourceHash: createHash("sha256").update(sceneSource).digest("hex"),
          sourcePath: "scene.py",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(originalExportResponse.status).toBe(200);
      expect(originalExportResponse.headers.get("content-disposition")).toBe('attachment; filename="scene.py"');
      expect(await originalExportResponse.text()).toBe(sceneSource);

      const mismatchedResponse = await fetch(`${origin}/api/manim/projects/project-b/export`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(mismatchedResponse.status).toBe(409);

      const unavailableRenderResponse = await fetch(`${origin}/api/manim/projects/project-a/renders`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unavailableRenderResponse.status).toBe(503);
      const unavailableRenderBody = await unavailableRenderResponse.text();
      expect(unavailableRenderBody).toContain("The configured Manim command is unavailable.");
      expect(unavailableRenderBody).not.toContain(privateCommandPath);
      expect(unavailableRenderBody).not.toContain(privateCommandArgument);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves persistent workspace CRUD without exposing or deleting project roots", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const addedRoot = await mkdtemp(join(tmpdir(), "poietra-http-project-"));
    temporaryRoots.push(addedRoot);
    await writeFile(join(addedRoot, "scene.py"), sceneSource, "utf8");
    const server = createServer((incoming, response) => {
      void handleManimRequest(createTrustedLocalManimRequestContext(registry, "test"), incoming, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const managedResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "managed", name: "Managed workspace" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(managedResponse.status).toBe(201);
      const managed = (await managedResponse.json()) as { project: { id: string; name: string } };
      expect(JSON.stringify(managed)).not.toContain(dataRoot);
      const managedWorkspaceResponse = await fetch(`${origin}/api/manim/projects/${managed.project.id}/workspace`);
      await expect(managedWorkspaceResponse.json()).resolves.toMatchObject({
        projectId: managed.project.id,
        sources: [{ path: "main.py", scenes: [{ name: "MainScene" }] }],
      });
      const nativeResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "studio-native", name: "Native workspace" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(nativeResponse.status).toBe(201);
      const native = (await nativeResponse.json()) as { project: { id: string } };
      const nativeWorkspaceResponse = await fetch(`${origin}/api/manim/projects/${native.project.id}/workspace`);
      const nativeWorkspace = manimWorkspaceViewSchema.parse(await nativeWorkspaceResponse.json());
      expect(nativeWorkspace).toMatchObject({
        nativeDocument: { documentKey: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        sources: [],
      });
      const managedWithRootResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "managed", name: "Invalid managed", root: addedRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(managedWithRootResponse.status).toBe(400);

      const createResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "existing", name: "Added workspace", root: addedRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        catalog: { projects: { id: string; name: string }[] };
        project: { id: string; name: string };
      };
      expect(JSON.stringify(created)).not.toContain(addedRoot);
      expect(created.project.name).toBe("Added workspace");

      const duplicateResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "existing", name: "Duplicate", root: addedRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(duplicateResponse.status).toBe(409);
      expect(JSON.stringify(await duplicateResponse.json())).not.toContain(addedRoot);

      const renameResponse = await fetch(`${origin}/api/manim/projects/${created.project.id}`, {
        body: JSON.stringify({ name: "Renamed workspace" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      expect(renameResponse.status).toBe(200);
      await expect(renameResponse.json()).resolves.toMatchObject({
        project: { id: created.project.id, name: "Renamed workspace" },
      });

      const deleteResponse = await fetch(`${origin}/api/manim/projects/${created.project.id}`, {
        headers: { "content-type": "application/json" },
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toMatchObject({ project: null });
      expect(await readFile(join(addedRoot, "scene.py"), "utf8")).toBe(sceneSource);

      const missingRoot = join(addedRoot, "private-missing-root");
      const invalidResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "existing", name: "Missing", root: missingRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(invalidResponse.status).toBe(400);
      expect(JSON.stringify(await invalidResponse.json())).not.toContain(missingRoot);
      const deleteManagedResponse = await fetch(`${origin}/api/manim/projects/${managed.project.id}`, {
        headers: { "content-type": "application/json" },
        method: "DELETE",
      });
      expect(deleteManagedResponse.status).toBe(200);
      const deleteNativeResponse = await fetch(`${origin}/api/manim/projects/${native.project.id}`, {
        headers: { "content-type": "application/json" },
        method: "DELETE",
      });
      expect(deleteNativeResponse.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
