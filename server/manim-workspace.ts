import { lstat, readFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";

import type { ManimWorkspaceSource } from "../src/render-pipeline/contracts";
import {
  findSceneBlocks,
  importManimScene,
  type ImportedManimScene,
} from "../src/render-pipeline/source-import";

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
        name: scene.name,
        nextSceneId: importedScenes[index + 1]?.sceneId ?? null,
        runtimeSceneState: scene.runtimeSceneState,
        sceneId: scene.sceneId,
        sourceHash: scene.sourceHash,
        sourceVariables: scene.sourceVariables,
        staticSemanticState: scene.staticSemanticState,
      })),
    },
  };
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
        const metadata = await lstat(absolutePath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PYTHON_SOURCE_BYTES) continue;
        source = await readFile(absolutePath, "utf8");
        if (Buffer.byteLength(source) > MAX_PYTHON_SOURCE_BYTES) continue;
      } catch {
        // Files can disappear or become unreadable during a workspace scan.
        continue;
      }
      const path = join(relativeDirectory, entry.name).split(sep).join("/");
      stopped = await visitSource({ path, source });
    }
  }
  await visit(projectRoot, "", true);
}

export async function discoverPythonSources(
  projectRoot: string,
  frame: Readonly<{ height: number; width: number }>,
) {
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
