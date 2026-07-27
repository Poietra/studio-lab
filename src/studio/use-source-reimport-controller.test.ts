import { describe, expect, it } from "vitest";

import type { RenderSourceRefreshTarget } from "../render-pipeline/render-pipeline-policy";
import {
  type SourceReimportActiveSource,
  SourceReimportGenerationController,
  type SourceReimportSelection,
} from "./use-source-reimport-controller";

const OLD_HASH = "a".repeat(64);
const RESULT_HASH = "b".repeat(64);
const target: RenderSourceRefreshTarget = {
  projectId: "project-a",
  resultSourceHash: RESULT_HASH,
  sceneName: "SceneOne",
  sourceHash: OLD_HASH,
  sourcePath: "scene.py",
};

function activeSource(overrides: Partial<SourceReimportActiveSource> = {}): SourceReimportActiveSource {
  return {
    projectId: target.projectId,
    sceneId: `${target.sourcePath}#${target.sceneName}`,
    sceneName: target.sceneName,
    sourceHash: target.sourceHash,
    sourcePath: target.sourcePath,
    ...overrides,
  };
}

function selection(overrides: Partial<SourceReimportSelection> = {}): SourceReimportSelection {
  return {
    activeProjectId: target.projectId,
    activeSource: activeSource(),
    ...overrides,
  };
}

describe("SourceReimportGenerationController", () => {
  it.each([
    [
      "workspace switch",
      selection({
        activeProjectId: "project-b",
        activeSource: activeSource({ projectId: "project-b" }),
      }),
    ],
    [
      "Scene switch",
      selection({
        activeSource: activeSource({ sceneId: "scene.py#SceneTwo", sceneName: "SceneTwo" }),
      }),
    ],
    [
      "source switch",
      selection({
        activeSource: activeSource({ sourceHash: "c".repeat(64) }),
      }),
    ],
  ])("rejects a stale completion after a %s", (_label, nextSelection) => {
    const controller = new SourceReimportGenerationController(selection());
    const ticket = controller.begin(target);
    expect(ticket).not.toBeNull();
    if (ticket === null) throw new Error("Expected the matching source re-import to start.");

    controller.synchronizeSelection(nextSelection);

    expect(controller.isCurrent(ticket)).toBe(false);
    controller.synchronizeSelection(selection());
    expect(controller.complete(ticket)).toBe(false);
    expect(controller.retains(target)).toBe(false);
  });

  it("keeps the exact post-mutation source revision in the same generation", () => {
    const controller = new SourceReimportGenerationController(selection());
    const ticket = controller.begin(target);
    expect(ticket).not.toBeNull();
    if (ticket === null) throw new Error("Expected the matching source re-import to start.");

    controller.synchronizeSelection(selection({ activeSource: activeSource({ sourceHash: target.resultSourceHash }) }));

    expect(controller.isCurrent(ticket)).toBe(true);
    expect(controller.complete(ticket)).toBe(true);
    expect(controller.retains(target)).toBe(false);
  });

  it("lets a newer re-import generation supersede an older completion", () => {
    const controller = new SourceReimportGenerationController(selection());
    const first = controller.begin(target);
    const second = controller.begin({ ...target });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) throw new Error("Expected both matching source re-imports to start.");

    expect(controller.complete(first)).toBe(false);
    expect(controller.complete(second)).toBe(true);
  });

  it("does not start work for a target outside the active source selection", () => {
    const controller = new SourceReimportGenerationController(selection());

    expect(controller.begin({ ...target, projectId: "project-b" })).toBeNull();
    expect(controller.begin({ ...target, sceneName: "SceneTwo" })).toBeNull();
    expect(controller.begin({ ...target, sourcePath: "other.py" })).toBeNull();
  });
});
