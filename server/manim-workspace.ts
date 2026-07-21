import { readFile, readdir } from "node:fs/promises";
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

export async function discoverPythonSources(
  projectRoot: string,
  frame: Readonly<{ height: number; width: number }>,
) {
  const sources: ManimWorkspaceSource[] = [];
  async function visit(directory: string, relativeDirectory: string) {
    if (sources.length >= 200) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (sources.length >= 200) return;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(join(directory, entry.name), join(relativeDirectory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
      const absolutePath = join(directory, entry.name);
      const source = await readFile(absolutePath, "utf8");
      const relativePath = join(relativeDirectory, entry.name).split(sep).join("/");
      const imported = importSourceSnapshot(source, relativePath, frame);
      if (imported.view.scenes.length > 0) sources.push(imported.view);
    }
  }
  await visit(projectRoot, "");
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export function sceneView(source: ManimWorkspaceSource, name: string) {
  return source.scenes.find((scene) => scene.name === name) ?? null;
}

export function importedScene(scenes: readonly ImportedManimScene[], name: string) {
  return scenes.find((scene) => scene.name === name) ?? null;
}
