import { type BigIntStats, constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, sep } from "node:path";

import {
  type BrowserManimProjectImportRequestV1,
  browserManimProjectImportRequestV1Schema,
  isManimSourcePath,
  type ManimWorkspaceSource,
} from "../src/render-pipeline/contracts";
import {
  analyzeDirectImageMobjectReferences,
  findSceneBlocks,
  type ImportedManimScene,
  importManimScene,
} from "../src/render-pipeline/source-import";
import { HttpError } from "./http/json";
import { inspectProjectPngBytesV1 } from "./storage/project-png-storage";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".poietra",
  ".venv",
  "__pycache__",
  "dist",
  "media",
  "node_modules",
  "target",
]);
const MAX_IMPORTED_SOURCES = 200;
const MAX_INSPECTED_PYTHON_SOURCES = 1_000;
const MAX_PYTHON_SOURCE_BYTES = 2 * 1024 * 1024;

type DiscoveredPythonSource = Readonly<{
  path: string;
  source: string;
}>;

function isSameFileVersion(first: BigIntStats, second: BigIntStats) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

async function readStablePythonSource(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_PYTHON_SOURCE_BYTES)) return null;
    const body = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!isSameFileVersion(before, after) || body.byteLength > MAX_PYTHON_SOURCE_BYTES) return null;
    return body.toString("utf8");
  } finally {
    await handle.close();
  }
}

export type ManimThumbnailTarget = Readonly<{
  scene: ImportedManimScene;
  source: string;
  sourcePath: string;
}>;

export type ImportedSourceSnapshot = Readonly<{
  importedScenes: readonly ImportedManimScene[];
  view: ManimWorkspaceSource;
}>;

export function importSourceSnapshot(
  source: string,
  path: string,
  frame: Readonly<{ height: number; width: number }>,
): ImportedSourceSnapshot {
  const importedScenes = findSceneBlocks(source).flatMap((block) => {
    const imported = importManimScene(source, path, block.name, frame);
    return imported ? [imported] : [];
  });
  return {
    importedScenes,
    view: {
      path,
      scenes: importedScenes.map((scene, index) => ({
        anchors: scene.anchors,
        importOutcomes: scene.importOutcomes,
        name: scene.name,
        nextSceneId:
          importedScenes[index + 1]?.sceneId === scene.sceneId ? null : (importedScenes[index + 1]?.sceneId ?? null),
        runtimeSceneState: scene.runtimeSceneState,
        sceneId: scene.sceneId,
        sourceHash: scene.sourceHash,
        sourceVariables: scene.sourceVariables,
        staticPrimitiveTransforms: scene.staticPrimitiveTransforms,
        staticSemanticState: scene.staticSemanticState,
      })),
    },
  };
}

export function validateBrowserManimProjectImportV1(
  request: BrowserManimProjectImportRequestV1,
  frame: Readonly<{ height: number; width: number }>,
) {
  const parsed = browserManimProjectImportRequestV1Schema.safeParse(request);
  if (!parsed.success) {
    throw new HttpError(parsed.error.issues[0]?.message ?? "The Python project import is invalid.", 400);
  }
  const imported = importSourceSnapshot(parsed.data.source, parsed.data.sourceName, frame);
  if (imported.view.scenes.length === 0) {
    throw new HttpError("The selected Python file does not contain an importable Manim Scene.", 422);
  }
  const imageReferences = analyzeDirectImageMobjectReferences(parsed.data.source);
  const importedImageReferences = imported.importedScenes.reduce(
    (count, scene) =>
      count +
      Object.values(scene.runtimeSceneState.objectGraph.entities).filter((entity) => entity.type === "ImageMobject")
        .length,
    0,
  );
  if (imageReferences.unsupportedReferences > 0) {
    throw new HttpError(
      'Browser imports support only direct ImageMobject assignments with literal "image.png" as the first argument or filename_or_array keyword.',
      422,
    );
  }
  if (imageReferences.exactImagePngReferences !== importedImageReferences) {
    throw new HttpError(
      "Browser imports support image.png only when every reference is a reachable direct ImageMobject assignment in an imported Scene.",
      422,
    );
  }
  if (imageReferences.exactImagePngReferences > 0 && parsed.data.imagePngBase64 === null) {
    throw new HttpError("This Python file references image.png. Select that PNG together with the Python file.", 422);
  }
  if (imageReferences.exactImagePngReferences === 0 && parsed.data.imagePngBase64 !== null) {
    throw new HttpError(
      "The selected image.png is not referenced by a direct ImageMobject assignment in this Python file.",
      422,
    );
  }
  let projectPng: ReturnType<typeof inspectProjectPngBytesV1> | null = null;
  if (parsed.data.imagePngBase64 !== null) {
    const bytes = Buffer.from(parsed.data.imagePngBase64, "base64");
    if (bytes.toString("base64") !== parsed.data.imagePngBase64) {
      throw new HttpError("The selected image.png must use canonical base64 encoding.", 422);
    }
    try {
      projectPng = inspectProjectPngBytesV1(bytes);
    } catch (error) {
      if (error instanceof Error) throw new HttpError(error.message, 422);
      throw new HttpError("The selected image.png does not satisfy Studio's strict PNG profile.", 422);
    }
  }
  return { imported, projectPng, request: parsed.data } as const;
}

async function visitPythonSources(
  projectRoot: string,
  visitSource: (source: DiscoveredPythonSource) => boolean | Promise<boolean>,
) {
  let inspectedPythonSources = 0;
  let stopped = false;
  async function visit(directory: string, relativeDirectory: string, isRoot = false): Promise<void> {
    if (stopped || inspectedPythonSources >= MAX_INSPECTED_PYTHON_SOURCES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRoot) throw error;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped || inspectedPythonSources >= MAX_INSPECTED_PYTHON_SOURCES) return;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(join(directory, entry.name), join(relativeDirectory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
      inspectedPythonSources += 1;
      const absolutePath = join(directory, entry.name);
      let source: string;
      try {
        const stableSource = await readStablePythonSource(absolutePath);
        if (stableSource === null) continue;
        source = stableSource;
      } catch {
        // Files can disappear or become unreadable during a workspace scan.
        continue;
      }
      const path = join(relativeDirectory, entry.name).split(sep).join("/");
      if (!isManimSourcePath(path)) continue;
      stopped = await visitSource({ path, source });
    }
  }
  await visit(projectRoot, "", true);
}

export async function discoverPythonSources(projectRoot: string, frame: Readonly<{ height: number; width: number }>) {
  const sources: ManimWorkspaceSource[] = [];
  await visitPythonSources(projectRoot, ({ path, source }) => {
    const imported = importSourceSnapshot(source, path, frame);
    if (imported.view.scenes.length > 0) sources.push(imported.view);
    return sources.length >= MAX_IMPORTED_SOURCES;
  });
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export async function discoverFirstManimScene(
  projectRoot: string,
  frame: Readonly<{ height: number; width: number }>,
): Promise<ImportedManimScene | null> {
  return (await discoverManimThumbnailTarget(projectRoot, frame))?.scene ?? null;
}

export async function discoverManimThumbnailTarget(
  projectRoot: string,
  frame: Readonly<{ height: number; width: number }>,
): Promise<ManimThumbnailTarget | null> {
  let target: ManimThumbnailTarget | null = null;
  await visitPythonSources(projectRoot, ({ path, source }) => {
    for (const block of findSceneBlocks(source)) {
      const imported = importManimScene(source, path, block.name, frame);
      if (!imported) continue;
      target = { scene: imported, source, sourcePath: path };
      return true;
    }
    return false;
  });
  return target;
}

export function sceneView(source: ManimWorkspaceSource, name: string) {
  return source.scenes.find((scene) => scene.name === name) ?? null;
}

export function importedScene(scenes: readonly ImportedManimScene[], name: string) {
  return scenes.find((scene) => scene.name === name) ?? null;
}
