import { describe, expect, it } from "vitest";
import {
  contentTransformClipFromProgram,
  createContentTransformProgram,
  replaceContentTransformProgram,
} from "./content-transform-clip-edit";
import { STUDIO_TEXT_DEFAULT_LAYOUT } from "./editable-content";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";

const ROOT_ID = "tx:create-equation/entity:equation";
const TEXT_ROOT_ID = "tx:create-text/entity:label";

function studioScene(): RuntimeSceneState {
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: {
        ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
        [ROOT_ID]: {
          content: { displayLines: ["E = mc^2"], label: "E = mc^2", texParts: ["E = mc^2"] },
          id: ROOT_ID,
          lifetime: [{ end: 10, start: 1 }],
          provisional: false,
          sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
          transactionId: "create-equation",
          type: "MathTex",
        },
      },
    },
  };
}

function textStudioScene(): RuntimeSceneState {
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: {
        ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
        [TEXT_ROOT_ID]: {
          content: {
            displayLines: ["あA", "Text"],
            text: "あA\nText",
            textLayout: STUDIO_TEXT_DEFAULT_LAYOUT,
          },
          id: TEXT_ROOT_ID,
          lifetime: [{ end: 10, start: 1 }],
          provisional: false,
          sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
          transactionId: "create-text",
          type: "Text",
        },
      },
    },
  };
}

describe("Studio Content Transform clip editing", () => {
  it("creates a replacement-only clip and preserves the logical root across edits", () => {
    const scene = studioScene();
    const created = createContentTransformProgram({
      capturedPlayhead: 2,
      content: { displayLines: ["Maxwell"], label: "Maxwell", texParts: [String.raw`\nabla \cdot E = 0`] },
      easing: "smooth",
      end: 3,
      rootEntityId: ROOT_ID,
      scene,
      sourceEntityId: ROOT_ID,
      start: 2,
      transactionId: "transform-maxwell",
    });
    const clip = contentTransformClipFromProgram(created.program, ROOT_ID);

    expect(clip).toMatchObject({
      easing: "smooth",
      interval: { end: 3, start: 2 },
      rootEntityId: ROOT_ID,
      transactionId: "transform-maxwell",
    });
    expect(clip?.targetEntityId).not.toBe(ROOT_ID);
    expect(created.program.operations[0]).toMatchObject({
      kind: "TransformContent",
      sourceEntityId: ROOT_ID,
      strategy: "replacement-transform",
      targetType: "MathTex",
    });

    const edited = replaceContentTransformProgram({
      baseProgram: created.program,
      duration: 1.5,
      easing: "linear",
      rootEntityId: ROOT_ID,
      scene,
    });
    expect(contentTransformClipFromProgram(edited.program, ROOT_ID)).toMatchObject({
      easing: "linear",
      interval: { end: 3.5, start: 2 },
      operationId: clip?.operationId,
      rootEntityId: ROOT_ID,
      targetEntityId: clip?.targetEntityId,
    });
  });

  it("keeps the logical root while chaining a later stage from the previous target", () => {
    const baseScene = studioScene();
    const previousTargetId = "tx:transform-maxwell/entity:math-tex-transform-target";
    const scene: RuntimeSceneState = {
      ...baseScene,
      objectGraph: {
        ...baseScene.objectGraph,
        entities: {
          ...baseScene.objectGraph.entities,
          [previousTargetId]: {
            content: { displayLines: ["Maxwell"], texParts: [String.raw`\nabla \cdot E = 0`] },
            id: previousTargetId,
            lifetime: [{ end: 10, start: 2 }],
            provisional: false,
            sourceIdentity: { kind: "unknown", reason: "Created by a Studio Transform." },
            transactionId: "transform-maxwell",
            type: "MathTex",
          },
        },
      },
    };

    const created = createContentTransformProgram({
      capturedPlayhead: 4,
      content: { displayLines: ["E = mc^2"], texParts: ["E = mc^2"] },
      easing: "linear",
      end: 5,
      rootEntityId: ROOT_ID,
      scene,
      sourceEntityId: previousTargetId,
      start: 4,
      transactionId: "transform-back",
    });

    expect(created.program.operations[0]).toMatchObject({ sourceEntityId: previousTargetId });
    expect(contentTransformClipFromProgram(created.program, ROOT_ID)).toMatchObject({
      rootEntityId: ROOT_ID,
      transactionId: "transform-back",
    });
  });

  it("creates a client-only Text Transform and requires unchanged typography", () => {
    const scene = textStudioScene();
    const content = {
      displayLines: ["あB", "次"],
      text: "あB\n次",
      textLayout: STUDIO_TEXT_DEFAULT_LAYOUT,
    };
    const created = createContentTransformProgram({
      capturedPlayhead: 2,
      content,
      easing: "smooth",
      end: 3,
      rootEntityId: TEXT_ROOT_ID,
      scene,
      sourceEntityId: TEXT_ROOT_ID,
      start: 2,
      transactionId: "transform-text",
    });

    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    expect(created.program.loweringStatus).toBe("unsupported");
    expect(created.program.operations[0]).toMatchObject({
      kind: "TransformContent",
      replacement: content,
      sourceEntityId: TEXT_ROOT_ID,
      targetType: "Text",
    });
    expect(contentTransformClipFromProgram(created.program, TEXT_ROOT_ID)).toMatchObject({
      content,
      rootEntityId: TEXT_ROOT_ID,
      targetType: "Text",
    });
    expect(() =>
      replaceContentTransformProgram({
        baseProgram: created.program,
        content: {
          ...content,
          textLayout: { ...STUDIO_TEXT_DEFAULT_LAYOUT, fontSize: 2 },
        },
        rootEntityId: TEXT_ROOT_ID,
        scene,
      }),
    ).toThrow(/typography/i);
  });

  it("rejects imported MathTex and clips outside the root lifetime", () => {
    expect(() =>
      createContentTransformProgram({
        capturedPlayhead: 2,
        content: { displayLines: ["x"], texParts: ["x"] },
        easing: "smooth",
        end: 3,
        rootEntityId: "equation_1",
        scene: studioScene(),
        sourceEntityId: "equation_1",
        start: 2,
        transactionId: "transform-imported",
      }),
    ).toThrow(/Studio-created/);

    expect(() =>
      createContentTransformProgram({
        capturedPlayhead: 9.5,
        content: { displayLines: ["x"], texParts: ["x"] },
        easing: "smooth",
        end: 10.5,
        rootEntityId: ROOT_ID,
        scene: studioScene(),
        sourceEntityId: ROOT_ID,
        start: 9.5,
        transactionId: "transform-too-long",
      }),
    ).toThrow(/lifetime/);
  });
});
