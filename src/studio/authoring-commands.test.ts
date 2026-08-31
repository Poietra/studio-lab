import { describe, expect, it } from "vitest";
import {
  createImportedEntityLifetimeProgram,
  createInspectorEntityEditProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  createStudioGroupLifetimeTrimProgram,
  createStudioGroupProgram,
  createStudioSceneBackgroundProgram,
  createStudioScenePostEffectProgram,
  defaultEntityContent,
  duplicateEntityInput,
  replaceStudioCreatedContentProgram,
  replaceStudioCreatedCubicBezierProgram,
  replaceStudioCreatedDataSeriesProgram,
  replaceStudioEntityLifetimeProgram,
  replaceStudioSceneBackgroundProgram,
  replaceStudioScenePostEffectProgram,
} from "./authoring-commands";
import {
  canonicalEditableContent,
  STUDIO_CREATION_TEXT_CONTRACT,
  STUDIO_TEXT_DEFAULT_LAYOUT,
} from "./editable-content";
import { canonicalAppliedProgramsWorkingRevisionV1 } from "./editor-revision-policy";
import { programRecord, projectProposedState } from "./evaluator";
import { createFixtureProposedState, projectPersistentRemoveFixture, STUDIO_FIXTURE_SCENE } from "./fixture";
import { studioLogicalGroupLifetimeTrimUnavailableReason } from "./lifetime-editing";
import { programExecutionCapabilities } from "./operation-registry";
import type { CanonicalEditOperation } from "./operations";
import { rebaseProgramTime } from "./program-composition";
import { validateAndScheduleProgram } from "./program-validation";
import { sceneEditOperationSchema } from "./scene-edit-contract";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";
import { STUDIO_STARTER_COMPOSITION_TITLE, studioStarterCompositionEntities } from "./starter-composition";
import { STUDIO_STYLE_PROFILE, styleProfileRef } from "./style-profile";
import {
  createInitialEditorState,
  editorProgramRecord,
  redoEditorProgram,
  undoEditorProgram,
} from "./use-editor-controller";
import { replaceWriteInProgram } from "./write-in-edit";

describe("manual Studio authoring commands", () => {
  function studioOwnedCircleScene(
    id: string,
    transactionId: string,
    lifetime: Readonly<{ end: number; start: number }> = { end: STUDIO_FIXTURE_SCENE.duration, start: 1 },
  ) {
    const source = STUDIO_FIXTURE_SCENE.objectGraph.entities.proof_box!;
    const position = STUDIO_FIXTURE_SCENE.propertyChannels["proof_box/position"]!;
    return {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          [id]: {
            ...source,
            geometry: {
              dimensions: { kind: "known" as const, value: { radius: 2 } },
              position: { kind: "known" as const, value: { x: 180, y: 120 } },
              scale: { kind: "known" as const, value: 1 },
              style: { kind: "known" as const, value: {} },
            },
            id,
            lifetime: [lifetime],
            sourceIdentity: { kind: "unknown" as const, reason: "Studio-owned test entity." },
            transactionId,
            type: "Circle",
          },
        },
      },
      propertyChannels: {
        ...STUDIO_FIXTURE_SCENE.propertyChannels,
        [`${id}/position`]: {
          ...position,
          entityId: id,
          samples: position.samples.map((sample) => ({ ...sample, value: { x: 180, y: 120 } })),
        },
      },
    };
  }

  function trimAvailability(waitOperationId: string) {
    return {
      anchor: 7,
      blocker: null,
      minimumDuration: 12,
      removableDuration: 3,
      waitOperationIds: [waitOperationId],
    } as const;
  }

  it("creates and replaces one preview-only opaque Scene background Program", () => {
    const created = createStudioSceneBackgroundProgram({
      color: "#123456",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scene-background",
    });
    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    expect(created.program).toMatchObject({
      anchor: { capturedPlayhead: 0, resolvedSeconds: 0 },
      loweringStatus: "unsupported",
      operations: [
        {
          color: "#123456",
          interval: { end: 0, start: 0 },
          kind: "SetSceneBackground",
          provenance: { origin: "studio-default" },
        },
      ],
    });
    expect(programExecutionCapabilities(created.program)).toMatchObject({
      apply: "supported",
      lowering: "unsupported",
    });

    const owner = programRecord(created.program, created);
    const replaced = replaceStudioSceneBackgroundProgram({
      color: "#654321",
      owner,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(replaced.kind, JSON.stringify(replaced.issues)).toBe("valid");
    expect(replaced.program.transactionId).toBe("scene-background");
    expect(replaced.program.operations[0]).toMatchObject({ color: "#654321", kind: "SetSceneBackground" });
    expect(() =>
      createStudioSceneBackgroundProgram({
        color: "#123456ff",
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "scene-background-alpha",
      }),
    ).toThrow(/#rrggbb/u);
  });

  it("creates, updates, and disables one built-in Scene post-effect Program", () => {
    const created = createStudioScenePostEffectProgram({
      capturedPlayhead: 3,
      effects: [{ parameters: [4, 2, 1, 0], revision: 1, shaderId: "rgb-split" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scene-post-effect",
    });
    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    expect(created.program).toMatchObject({
      anchor: { capturedPlayhead: 3, resolvedSeconds: 3 },
      loweringStatus: "unsupported",
      operations: [
        {
          effects: [{ parameters: [4, 2, 1, 0], revision: 1, shaderId: "rgb-split" }],
          interval: { end: 3, start: 3 },
          kind: "SetScenePostEffect",
          parameterTracks: [],
        },
      ],
    });
    expect(programExecutionCapabilities(created.program)).toMatchObject({
      apply: "supported",
      lowering: "unsupported",
    });

    const owner = programRecord(created.program, created);
    const updated = replaceStudioScenePostEffectProgram({
      effects: [{ parameters: [8, 1, 0.5, Math.PI], revision: 1, shaderId: "rgb-split" }],
      owner,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(updated.kind, JSON.stringify(updated.issues)).toBe("valid");
    expect(updated.program.operations[0]).toMatchObject({
      effects: [{ parameters: [8, 1, 0.5, Math.PI] }],
      kind: "SetScenePostEffect",
    });
    expect(
      replaceStudioScenePostEffectProgram({ effects: [], owner, scene: STUDIO_FIXTURE_SCENE }).program.operations[0],
    ).toMatchObject({ effects: [], kind: "SetScenePostEffect" });

    const operation = created.program.operations[0];
    if (operation?.kind !== "SetScenePostEffect") throw new Error("missing Scene post-effect operation");
    const { effects, parameterTracks: _parameterTracks, ...legacyOperation } = operation;
    expect(sceneEditOperationSchema.parse({ ...legacyOperation, effect: effects[0] })).toEqual(operation);
    expect(() =>
      createStudioScenePostEffectProgram({
        capturedPlayhead: 3,
        effects: [
          { ...effects[0]!, parameters: [...effects[0]!.parameters] },
          { ...effects[0]!, parameters: [...effects[0]!.parameters] },
        ],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "duplicate-scene-post-effect",
      }),
    ).toThrow(/same shader revision/u);
  });

  it("stores multiple bounded Scene post-effect parameter tracks and preserves them across stack updates", () => {
    const effects = [{ parameters: [4, 2, 1, 0], revision: 1, shaderId: "rgb-split" }] as const;
    const offsetTrack = {
      keyframes: [
        { easing: "ease-in" as const, time: 0, value: 4 },
        { easing: "smooth" as const, time: 2, value: 8 },
      ],
      name: "  Offset  ",
      parameterIndex: 0,
      revision: 1,
      shaderId: "rgb-split",
    };
    const angleTrack = {
      keyframes: [
        { easing: "linear" as const, time: 0, value: 2 },
        { easing: "ease-out" as const, time: 3, value: 6 },
      ],
      name: "Angle",
      parameterIndex: 1,
      revision: 1,
      shaderId: "rgb-split",
    };
    const created = createStudioScenePostEffectProgram({
      capturedPlayhead: 0,
      effects,
      parameterTracks: [offsetTrack, angleTrack],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scene-post-effect-parameter",
    });

    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    const operation = created.program.operations[0];
    if (operation?.kind !== "SetScenePostEffect") throw new Error("missing Scene post-effect operation");
    expect(operation.parameterTracks).toEqual([{ ...offsetTrack, name: "Offset" }, angleTrack]);

    const replaced = replaceStudioScenePostEffectProgram({
      effects,
      owner: programRecord(created.program, created),
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(replaced.program.operations[0]).toMatchObject({
      kind: "SetScenePostEffect",
      parameterTracks: [
        { keyframes: offsetTrack.keyframes, name: "Offset" },
        { keyframes: angleTrack.keyframes, name: "Angle" },
      ],
    });

    const { parameterTracks: _parameterTracks, ...legacyOperation } = operation;
    expect(sceneEditOperationSchema.parse({ ...legacyOperation, parameterTrack: offsetTrack })).toEqual({
      ...operation,
      parameterTracks: [{ ...offsetTrack, name: "Offset" }],
    });

    const outsideScene = createStudioScenePostEffectProgram({
      capturedPlayhead: 0,
      effects,
      parameterTracks: [
        {
          ...offsetTrack,
          keyframes: [
            offsetTrack.keyframes[0],
            { easing: "smooth", time: STUDIO_FIXTURE_SCENE.duration + 1, value: 8 },
          ],
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scene-post-effect-outside-scene",
    });
    expect(outsideScene.kind).toBe("invalid");
    expect(outsideScene.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "parameterTracks", severity: "error" })]),
    );
    expect(() =>
      createStudioScenePostEffectProgram({
        capturedPlayhead: 0,
        effects,
        parameterTracks: [{ ...offsetTrack, keyframes: [offsetTrack.keyframes[0]] }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "scene-post-effect-single-marker",
      }),
    ).toThrow(/>=2/u);
    expect(() =>
      createStudioScenePostEffectProgram({
        capturedPlayhead: 0,
        effects,
        parameterTracks: [offsetTrack, { ...offsetTrack, name: "Duplicate" }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "duplicate-scene-post-effect-parameter-track",
      }),
    ).toThrow(/at most one track/u);
    expect(() =>
      createStudioScenePostEffectProgram({
        capturedPlayhead: 0,
        effects,
        parameterTracks: [{ ...offsetTrack, revision: 2 }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "unknown-scene-post-effect-revision",
      }),
    ).toThrow(/existing effect parameter/u);
    expect(() =>
      createStudioScenePostEffectProgram({
        capturedPlayhead: 0,
        effects,
        parameterTracks: Array.from({ length: 33 }, (_, parameterIndex) => ({
          ...offsetTrack,
          parameterIndex: parameterIndex % 8,
          revision: Math.floor(parameterIndex / 8) + 1,
        })),
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "too-many-scene-post-effect-parameter-tracks",
      }),
    ).toThrow(/<=32/u);
  });

  it("projects Inspector position and content edits from one canonical program", () => {
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: {
        content: {
          displayLines: ["F = ma"],
          label: "equation",
          texParts: ["F", "=", "m", "a"],
        },
        position: { x: 410, y: 170 },
      },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-equation",
    });

    expect(validation.kind, JSON.stringify(validation.issues)).toBe("valid");
    expect(validation.program.operations).toEqual([
      expect.objectContaining({
        entityId: "equation_1",
        key: "position",
        kind: "SetProperty",
        value: { x: 410, y: 170 },
      }),
      expect.objectContaining({
        entityId: "equation_1",
        key: "content",
        kind: "SetProperty",
        value: expect.objectContaining({ texParts: ["F", "=", "m", "a"] }),
      }),
    ]);
  });

  it("stores Japanese multiline Text with canonical LF content in the creation Program", () => {
    const text = "日本語で動画を作る\r\nこんにちは";
    const canonical = "日本語で動画を作る\nこんにちは";
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          content: { displayLines: [text], label: text, text },
          position: { x: 200, y: 120 },
          type: "Text",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-text-source",
    });
    const create = creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity");
    expect(create?.kind).toBe("CreateEntity");
    if (create?.kind !== "CreateEntity") return;
    expect(create.entity.content).toEqual({
      displayLines: ["日本語で動画を作る", "こんにちは"],
      label: canonical,
      text: canonical,
      textLayout: { alignment: "left", fontFamily: "sans", fontSize: 1, fontWeight: "regular", lineHeight: 1.2 },
    });
    const lfCreation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          content: { displayLines: canonical.split("\n"), label: canonical, text: canonical },
          position: { x: 200, y: 120 },
          type: "Text",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-text-source",
    });
    expect(canonicalAppliedProgramsWorkingRevisionV1([creation.validation.program])).toBe(
      canonicalAppliedProgramsWorkingRevisionV1([lfCreation.validation.program]),
    );
  });

  it("stores a bounded data series and replaces only its owning DataPlot payload", () => {
    const dimensions = {
      coordinateSystem: {
        x: { maximum: 5, minimum: -5, step: 1 },
        y: { maximum: 3, minimum: -3, step: 1 },
      },
      height: 4,
      width: 6,
    } as const;
    const initial = {
      interpolation: "linear" as const,
      points: [
        { x: -1, y: 0 },
        { x: 1, y: 2 },
      ],
    };
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ dataSeries: initial, dimensions, position: { x: 300, y: 180 }, type: "DataPlot" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "create-data-plot",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const owner = programRecord(creation.validation.program, creation.validation);
    const replacement = replaceStudioCreatedDataSeriesProgram({
      dataSeries: {
        interpolation: "smooth",
        points: [
          { x: -2, y: -1 },
          { x: 0, y: 2 },
          { x: 2, y: 0 },
        ],
      },
      entityId: creation.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(replacement.kind, JSON.stringify(replacement.issues)).toBe("valid");
    expect(replacement.program.transactionId).toBe(owner.program.transactionId);
    expect(replacement.program.operations).toHaveLength(owner.program.operations.length);
    expect(replacement.program.operations).toContainEqual(
      expect.objectContaining({
        entity: expect.objectContaining({
          dataSeries: {
            interpolation: "smooth",
            points: [
              { x: -2, y: -1 },
              { x: 0, y: 2 },
              { x: 2, y: 0 },
            ],
          },
          dimensions,
          type: "DataPlot",
        }),
        kind: "CreateEntity",
      }),
    );
    expect(replacement.program.operations.filter((operation) => operation.kind !== "CreateEntity")).toEqual(
      owner.program.operations.filter((operation) => operation.kind !== "CreateEntity"),
    );
  });

  it("keeps Text content and layout in one reversible Inspector transaction", () => {
    const content = {
      displayLines: ["Wide", "i"],
      text: "Wide\ni",
      textLayout: {
        alignment: "right" as const,
        fontFamily: "mono" as const,
        fontSize: 1.5,
        fontWeight: "bold" as const,
        lineHeight: 1.8,
        wrapWidth: 6,
      },
    };
    expect(() =>
      createInspectorEntityEditProgram({
        capturedPlayhead: 5,
        edits: { content },
        entityId: "label_1",
        from: { position: { x: 384, y: 224 }, scale: 1 },
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "imported-text-layout-edit",
      }),
    ).toThrow(/only for Studio-created Text/i);
    const studioScene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          label_1: {
            ...STUDIO_FIXTURE_SCENE.objectGraph.entities.label_1!,
            sourceIdentity: { kind: "unknown" as const, reason: "Created in Studio." },
            transactionId: "create-text",
          },
        },
      },
    };
    expect(() =>
      createInspectorEntityEditProgram({
        capturedPlayhead: 5,
        edits: { content },
        entityId: "label_1",
        from: { position: { x: 384, y: 224 }, scale: 1 },
        scene: studioScene,
        transactionId: "later-text-layout-edit",
      }),
    ).toThrow(/replace its creation Program/i);
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          content: { displayLines: ["Before"], text: "Before" },
          position: { x: 384, y: 224 },
          type: "Text",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "create-text",
    });
    const owner = programRecord(creation.validation.program, creation.validation);
    const validation = replaceStudioCreatedContentProgram({
      content,
      entityId: creation.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(validation.kind, JSON.stringify(validation.issues)).toBe("valid");
    expect(validation.program.transactionId).toBe(owner.program.transactionId);
    expect(validation.program.anchor).toEqual(owner.program.anchor);
    expect(validation.program.operations).toContainEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ content, id: creation.entityIds[0], type: "Text" }),
        kind: "CreateEntity",
      }),
    );
    expect(
      validation.program.operations.some(
        (operation) => operation.kind === "SetProperty" && operation.key === "content",
      ),
    ).toBe(false);

    const original = editorProgramRecord(owner, null, [creation.entityIds[0]!]);
    const applied = editorProgramRecord(programRecord(validation.program, validation), null, [creation.entityIds[0]!]);
    const state = {
      ...createInitialEditorState(),
      appliedPrograms: [applied],
      programUndoEntries: [
        { index: 0, kind: "append" as const, value: original },
        { index: 0, kind: "replace" as const, previous: original, value: applied },
      ],
      selectedObjectIds: ["label_1"],
    };
    const undone = undoEditorProgram(state);
    expect(undone.appliedPrograms).toEqual([original]);
    expect(
      undone.appliedPrograms[0]?.program.operations.find((operation) => operation.kind === "CreateEntity"),
    ).toMatchObject({
      entity: { content: { text: "Before", textLayout: { fontFamily: "sans", fontWeight: "regular" } } },
    });
    const redone = redoEditorProgram(undone);
    expect(redone.appliedPrograms).toEqual([applied]);
    expect(
      redone.appliedPrograms[0]?.program.operations.find((operation) => operation.kind === "CreateEntity"),
    ).toMatchObject({
      entity: {
        content: { text: "Wide\ni", textLayout: { fontFamily: "mono", fontWeight: "bold", wrapWidth: 6 } },
      },
    });
  });

  it.each(["tab\tbreak", ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n"), "x".repeat(129)])(
    "rejects Text creation outside the bounded Unicode multiline contract: %s",
    (text) => {
      expect(() =>
        createStudioEntitiesProgram({
          capturedPlayhead: 1,
          entities: [
            {
              content: { displayLines: [text], text },
              position: { x: 200, y: 120 },
              type: "Text",
            },
          ],
          scene: STUDIO_FIXTURE_SCENE,
          transactionId: "invalid-text-source",
        }),
      ).toThrow(STUDIO_CREATION_TEXT_CONTRACT);
    },
  );

  it("admits a 129-scalar Text line only when a canonical wrap width is present", () => {
    const text = "x".repeat(129);
    const content = { displayLines: [text], text };

    expect(canonicalEditableContent(content, "Text")).toBeNull();
    expect(
      canonicalEditableContent(
        { ...content, textLayout: { ...STUDIO_TEXT_DEFAULT_LAYOUT, fontSize: 2, wrapWidth: 6 } },
        "Text",
      ),
    ).toMatchObject({ text, textLayout: { fontSize: 2, wrapWidth: 6 } });
  });

  it("replaces Studio MathTex creation content without removing its Write entrance", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          content: { displayLines: ["E = mc^2"], label: "E = mc^2", texParts: ["E = mc^2"] },
          position: { x: 384, y: 224 },
          type: "MathTex",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "create-mathtex",
    });
    const entityId = creation.entityIds[0]!;
    const withWrite = replaceWriteInProgram({
      baseProgram: creation.validation.program,
      entityId,
      fragmentMaterial: null,
      scene: STUDIO_FIXTURE_SCENE,
      write: { easing: "linear", end: 2.5 },
    });
    expect(withWrite.kind, JSON.stringify(withWrite.issues)).toBe("valid");
    const content = { displayLines: ["F = ma"], label: "F = ma", texParts: ["F = ma"] };
    const replacement = replaceStudioCreatedContentProgram({
      content,
      entityId,
      owner: programRecord(withWrite.program, withWrite),
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(replacement.kind, JSON.stringify(replacement.issues)).toBe("valid");
    expect(replacement.program.operations).toContainEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ content, id: entityId, type: "MathTex" }),
        kind: "CreateEntity",
      }),
    );
    expect(replacement.program.operations).toContainEqual(expect.objectContaining({ entityId, kind: "WriteIn" }));
    expect(
      replacement.program.operations.some(
        (operation) => operation.kind === "SetProperty" && operation.key === "content",
      ),
    ).toBe(false);
  });

  it("combines Inspector position and shape dimensions into the existing ResizeEntity operation", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions: { radius: 2 }, position: { x: 180, y: 120 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-circle-source",
    });
    const scene = studioOwnedCircleScene(creation.entityIds[0]!, creation.validation.program.transactionId);
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: { dimensions: { radius: 3 }, position: { x: 210, y: 150 } },
      entityId: creation.entityIds[0],
      from: { dimensions: { radius: 2 }, position: { x: 180, y: 120 }, scale: 1 },
      scene,
      transactionId: "inspector-circle-edit",
    });

    expect(validation.kind, JSON.stringify(validation.issues)).toBe("valid");
    expect(validation.program.operations).toEqual([
      expect.objectContaining({
        from: { dimensions: { radius: 2 }, position: { x: 180, y: 120 } },
        kind: "ResizeEntity",
        to: { dimensions: { radius: 3 }, position: { x: 210, y: 150 } },
      }),
    ]);
  });

  it("canonicalizes Studio Rectangle corner radius and rejects imported ownership", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 180, y: 120 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "rounded-rectangle-source",
    });
    expect(creation.validation.program.operations).toContainEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ dimensions: { cornerRadius: 0, height: 2, width: 4 } }),
        kind: "CreateEntity",
      }),
    );

    expect(() =>
      createInspectorEntityEditProgram({
        capturedPlayhead: 5,
        edits: { dimensions: { cornerRadius: 0.5, height: 2, width: 4 } },
        entityId: "proof_box",
        from: { dimensions: { height: 2, width: 4 }, position: { x: 450, y: 180 }, scale: 1 },
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "imported-rounded-rectangle",
      }),
    ).toThrow(/only Studio-created Rectangles/u);
  });

  it("fails closed when Inspector content targets an imported entity without source identity", () => {
    const scene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          equation_1: {
            ...STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1,
            sourceIdentity: { kind: "unknown" as const, reason: "Runtime alias" },
          },
        },
      },
    };

    const knownValidation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: { content: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] } },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "known-inspector-content",
    });
    const revalidated = validateAndScheduleProgram(knownValidation.program, scene);
    expect(revalidated.kind).toBe("invalid");
    expect(revalidated.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "identity-unknown", field: "entityId", severity: "error" }),
      ]),
    );

    expect(() =>
      createInspectorEntityEditProgram({
        capturedPlayhead: 5,
        edits: { content: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] } },
        entityId: "equation_1",
        from: { position: { x: 384, y: 146 }, scale: 1 },
        scene,
        transactionId: "unsafe-inspector-content",
      }),
    ).toThrow(/known or Studio-generated source identity/i);
  });

  it("rejects content whose canonical shape does not match the selected entity type", () => {
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: { content: { displayLines: ["plain text"], text: "plain text" } },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "invalid-inspector-content-shape",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "value", severity: "error" })]),
    );
  });

  it("rejects Inspector content outside the shared round-trip contract", () => {
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: {
        content: {
          displayLines: ["F = ma"],
          label: "equation".repeat(300),
          texParts: ["F", "=", "m", "a"],
        },
      },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "invalid-inspector-content-contract",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "value", severity: "error" })]),
    );
  });

  it("creates and positions an entity in one canonical Program", () => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-circle",
    });
    expect(result.validation.kind).toBe("valid");
    expect(result.validation.program.operations.map((operation) => operation.kind)).toEqual([
      "CreateEntity",
      "SetProperty",
      "ChangePresence",
    ]);

    expect(result.validation.program.operations).toEqual([
      expect.objectContaining({
        entity: expect.objectContaining({ id: result.entityIds[0], type: "Circle" }),
        kind: "CreateEntity",
      }),
      expect.objectContaining({
        entityId: result.entityIds[0],
        key: "position",
        kind: "SetProperty",
        value: { x: 180, y: 120 },
      }),
      expect.objectContaining({ effect: "fade-in", entityId: result.entityIds[0], kind: "ChangePresence" }),
    ]);
    const appearance = result.validation.program.operations.find(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
    );
    expect(appearance).toBeDefined();
    if (!appearance) return;
    expect(appearance.interval.end - appearance.interval.start).toBeCloseTo(STUDIO_STYLE_PROFILE.durationSeconds.brief);
    expect(result.validation.program.provenance.styleProfileRef).toEqual(styleProfileRef(STUDIO_STYLE_PROFILE));
  });

  it("recomputes source lowering when a Studio-created cubic path is closed and reopened", () => {
    const cubicBezier = {
      arrowEnd: false,
      control1: { x: -1, y: 1 },
      control2: { x: 1, y: -1 },
      end: { x: 2, y: 0 },
      start: { x: -2, y: 0 },
      strokeCap: "round" as const,
      strokeWidth: 0.04,
    };
    const created = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          cubicBezier,
          dimensions: { height: 2, width: 4 },
          position: { x: 320, y: 180 },
          type: "CubicBezier",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-cubic-bezier",
    });
    expect(created.validation.kind).toBe("valid");
    expect(programExecutionCapabilities(created.validation.program)).toMatchObject({
      apply: "supported",
      lowering: "supported",
    });
    const entityId = created.entityIds[0]!;
    expect(created.validation.program.operations[0]).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ cubicBezier, dimensions: { height: 2, width: 4 }, type: "CubicBezier" }),
        kind: "CreateEntity",
      }),
    );

    const owner = programRecord(created.validation.program, created.validation);
    const continuationSegments = [
      {
        control1: { x: 2.5, y: 1 },
        control2: { x: 3.5, y: 1 },
        end: { x: 4, y: 0 },
      },
    ];
    const replacement = replaceStudioCreatedCubicBezierProgram({
      cubicBezier: {
        ...cubicBezier,
        closed: true,
        continuationSegments,
        control1: { x: -0.5, y: 1 },
        fillColor: "#38bdf8",
      },
      dimensions: { height: 2, width: 4 },
      entityId,
      owner,
      position: { x: 325, y: 175 },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(replacement.kind).toBe("valid");
    expect(replacement.program.loweringStatus).toBe("unsupported");
    expect(replacement.program.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: expect.objectContaining({
            cubicBezier: expect.objectContaining({
              closed: true,
              continuationSegments,
              control1: { x: -0.5, y: 1 },
              fillColor: "#38bdf8",
            }),
          }),
          kind: "CreateEntity",
        }),
        expect.objectContaining({ kind: "SetProperty", key: "position", value: { x: 325, y: 175 } }),
      ]),
    );

    const reopened = replaceStudioCreatedCubicBezierProgram({
      cubicBezier: {
        ...cubicBezier,
        continuationSegments,
        control1: { x: -0.5, y: 1 },
      },
      dimensions: { height: 2, width: 4 },
      entityId,
      owner: programRecord(replacement.program, replacement),
      position: { x: 325, y: 175 },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(reopened.kind, JSON.stringify(reopened.issues)).toBe("valid");
    expect(reopened.program.loweringStatus).toBe("supported");
    expect(programExecutionCapabilities(reopened.program)).toMatchObject({
      apply: "supported",
      lowering: "supported",
    });
  });

  it("creates a manifest-backed Image through the canonical Program while reporting source export unsupported", () => {
    const image = {
      asset: { assetId: "image-scene/asset:image.png", sha256: "4".repeat(64) },
      localRect: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
      sampler: "nearest" as const,
    };
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ image, position: { x: 320, y: 180 }, type: "ImageMobject" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-native-image",
    });

    expect(result.validation.kind).toBe("valid");
    expect(result.validation.program.loweringStatus).toBe("unsupported");
    expect(programExecutionCapabilities(result.validation.program)).toMatchObject({
      apply: "supported",
      lowering: "unsupported",
    });
    expect(result.validation.program.operations[0]).toMatchObject({
      entity: { image, type: "ImageMobject" },
      kind: "CreateEntity",
    });
    expect(result.validation.program.operations[0]).not.toHaveProperty("entity.content");
    expect(() => canonicalAppliedProgramsWorkingRevisionV1([result.validation.program])).not.toThrow();
  });

  it("creates the starter title card as ordinary editable entities with the standard fade-in", () => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: studioStarterCompositionEntities(),
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "starter-title-card",
    });

    expect(result.validation.kind).toBe("valid");
    expect(result.entityIds).toHaveLength(2);
    expect(
      result.validation.program.operations
        .filter((operation) => operation.kind === "CreateEntity")
        .map((operation) => ({ content: operation.entity.content?.text, type: operation.entity.type })),
    ).toEqual([
      { content: undefined, type: "Rectangle" },
      { content: STUDIO_STARTER_COMPOSITION_TITLE, type: "Text" },
    ]);
    expect(
      result.validation.program.operations.filter(
        (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
      ),
    ).toHaveLength(2);
  });

  it("rejects creation dimensions that do not match the entity type", () => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          dimensions: { width: 4 },
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "invalid-circle-dimensions",
    });

    expect(result.validation.kind).toBe("invalid");
    expect(result.validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/^entity\.dimensions/u), severity: "error" }),
      ]),
    );
  });

  it("preserves custom shape dimensions in the canonical creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions: { radius: 2 }, position: { x: 180, y: 120 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "custom-circle",
    });
    expect(creation.validation.kind).toBe("valid");
    expect(creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity")).toEqual(
      expect.objectContaining({ entity: expect.objectContaining({ dimensions: { radius: 2 } }) }),
    );
  });

  it("writes canonical shape defaults into the creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 180, y: 120 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "default-circle",
    });
    expect(creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity")).toEqual(
      expect.objectContaining({ entity: expect.objectContaining({ dimensions: { radius: 1 } }) }),
    );
  });

  it("writes Triangle and Regular Polygon as bounded regular-polygon presets", () => {
    const triangle = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 180, y: 120 }, type: "Triangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "default-triangle",
    });
    const polygon = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions: { radius: 2, sides: 12 }, position: { x: 180, y: 120 }, type: "RegularPolygon" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "custom-regular-polygon",
    });

    expect(triangle.validation.kind, JSON.stringify(triangle.validation.issues)).toBe("valid");
    expect(polygon.validation.kind, JSON.stringify(polygon.validation.issues)).toBe("valid");
    expect(triangle.validation.program.operations.find(({ kind }) => kind === "CreateEntity")).toMatchObject({
      entity: { dimensions: { radius: 1, sides: 3 }, type: "Triangle" },
    });
    expect(polygon.validation.program.operations.find(({ kind }) => kind === "CreateEntity")).toMatchObject({
      entity: { dimensions: { radius: 2, sides: 12 }, type: "RegularPolygon" },
    });
  });

  it("writes bounded native curve defaults into creation Programs", () => {
    const creations = (["Ellipse", "Arc", "Sector"] as const).map((type) =>
      createStudioEntitiesProgram({
        capturedPlayhead: 5,
        entities: [{ position: { x: 180, y: 120 }, type }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: `default-${type}`,
      }),
    );

    expect(creations.every((creation) => creation.validation.kind === "valid")).toBe(true);
    const entities = creations.map((creation) => {
      const operation = creation.validation.program.operations.find(({ kind }) => kind === "CreateEntity");
      if (operation?.kind !== "CreateEntity") throw new Error("Curve creation fixture is incomplete.");
      return operation.entity;
    });
    expect(entities).toEqual([
      expect.objectContaining({ dimensions: { height: 2, width: 3 }, type: "Ellipse" }),
      expect.objectContaining({ dimensions: { angles: { start: 0, sweep: Math.PI / 2 }, radius: 1 }, type: "Arc" }),
      expect.objectContaining({ dimensions: { angles: { start: 0, sweep: Math.PI / 2 }, radius: 1 }, type: "Sector" }),
    ]);
  });

  it.each([
    ["Arc", { angles: { start: 0, sweep: 0 }, radius: 1 }],
    ["Arc", { angles: { start: 0, sweep: 5e-7 }, radius: 1 }],
    ["Sector", { angles: { start: 0, sweep: Math.PI * 2 + 5e-10 }, radius: 1 }],
    ["Sector", { angles: { start: 0, sweep: Math.PI * 3 }, radius: 1 }],
    ["Ellipse", { height: 2, radius: 1, width: 3 }],
  ] as const)("rejects invalid %s curve dimensions", (type, dimensions) => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions, position: { x: 180, y: 120 }, type }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: `invalid-${type}`,
    });

    expect(result.validation.kind).toBe("invalid");
  });

  it("writes bounded coordinate object defaults into creation Programs", () => {
    const creations = (["NumberLine", "Axes", "NumberPlane"] as const).map((type) =>
      createStudioEntitiesProgram({
        capturedPlayhead: 5,
        entities: [{ position: { x: 180, y: 120 }, type }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: `default-${type}`,
      }),
    );

    expect(creations.every(({ validation }) => validation.kind === "valid")).toBe(true);
    const dimensions = creations.map(({ validation }) => {
      const operation = validation.program.operations.find(({ kind }) => kind === "CreateEntity");
      if (operation?.kind !== "CreateEntity") throw new Error("Coordinate creation fixture is incomplete.");
      return operation.entity.dimensions;
    });
    expect(dimensions).toEqual([
      { coordinateSystem: { x: { maximum: 5, minimum: -5, step: 1 } }, width: 6 },
      {
        coordinateSystem: {
          x: { maximum: 5, minimum: -5, step: 1 },
          y: { maximum: 3, minimum: -3, step: 1 },
        },
        height: 4,
        width: 6,
      },
      {
        coordinateSystem: {
          x: { maximum: 5, minimum: -5, step: 1 },
          y: { maximum: 3, minimum: -3, step: 1 },
        },
        height: 4,
        width: 6,
      },
    ]);
  });

  it.each([
    [
      "NumberLine",
      {
        coordinateSystem: { x: { maximum: 5, minimum: -5, step: 1 }, y: { maximum: 3, minimum: -3, step: 1 } },
        width: 6,
      },
    ],
    ["Axes", { coordinateSystem: { x: { maximum: 5, minimum: -5, step: 1 } }, height: 4, width: 6 }],
    [
      "NumberPlane",
      {
        coordinateSystem: { x: { maximum: 1, minimum: 1, step: 1 }, y: { maximum: 3, minimum: -3, step: 1 } },
        height: 4,
        width: 6,
      },
    ],
    ["NumberLine", { coordinateSystem: { x: { maximum: 128, minimum: 0, step: 1 } }, width: 6 }],
    [
      "NumberLine",
      {
        coordinateSystem: { x: { maximum: Number.MAX_VALUE, minimum: -Number.MAX_VALUE, step: 1 } },
        width: 6,
      },
    ],
  ] as const)("rejects invalid %s coordinate dimensions", (type, dimensions) => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions, position: { x: 180, y: 120 }, type }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: `invalid-${type}`,
    });

    expect(result.validation.kind).toBe("invalid");
  });

  it.each([
    ["RegularPolygon", { radius: 1, sides: 2 }],
    ["RegularPolygon", { radius: 1, sides: 33 }],
    ["RegularPolygon", { radius: 1, sides: 3.5 }],
    ["Triangle", { radius: 1, sides: 4 }],
  ] as const)("rejects invalid %s creation dimensions", (type, dimensions) => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions, position: { x: 180, y: 120 }, type }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: `invalid-${type}-${dimensions.sides}`,
    });

    expect(result.validation.kind).toBe("invalid");
    expect(result.validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/^entity\.dimensions/u), severity: "error" }),
      ]),
    );
  });

  it("rejects resize of an entity created in the same unapplied program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 180, y: 120 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "create-and-resize",
    });
    const create = creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity");
    if (!create) throw new Error("Expected a CreateEntity operation.");
    const resize = {
      dependsOn: [create.id],
      entityId: creation.entityIds[0],
      from: { dimensions: { radius: 1 }, position: { x: 180, y: 120 } },
      id: "tx:create-and-resize/operation:invalid-resize",
      interval: { end: 5, start: 5 },
      kind: "ResizeEntity" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      scale: 1,
      shape: "circle" as const,
      to: { dimensions: { radius: 2 }, position: { x: 200, y: 140 } },
    };
    const operations = [...creation.validation.program.operations, resize];
    const validation = validateAndScheduleProgram(
      {
        ...creation.validation.program,
        operations,
        schedule: {
          ...creation.validation.program.schedule,
          order: [...creation.validation.program.schedule.order, resize.id],
        },
      },
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "target", operationId: resize.id, severity: "error" })]),
    );
  });

  it("duplicates only types supported by the Insert tool", () => {
    const equation = projectProposedState(createFixtureProposedState(), 5).canvas.entities.find(
      (entity) => entity.id === "equation_1",
    );
    expect(equation).toBeDefined();
    if (!equation) return;
    const duplicate = duplicateEntityInput(equation);
    expect(duplicate).toEqual(
      expect.objectContaining({
        position: {
          x: equation.position.x + STUDIO_STYLE_PROFILE.spacingUnitPx,
          y: equation.position.y + STUDIO_STYLE_PROFILE.spacingUnitPx,
        },
        type: "MathTex",
      }),
    );
    expect(duplicate).not.toHaveProperty("dimensions");
    if (!duplicate) return;
    expect(
      createStudioEntitiesProgram({
        capturedPlayhead: 5,
        entities: [duplicate],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "duplicate-equation",
      }).validation.kind,
    ).toBe("valid");
  });

  it("creates a persistent remove operation for the Delete command", () => {
    const result = createRemoveEntitiesProgram({
      capturedPlayhead: 5,
      entityIds: ["equation_1"],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "delete-equation",
    });
    expect(result.kind).toBe("valid");
    expect(result.program.operations).toEqual([
      expect.objectContaining({ effect: "remove", entityId: "equation_1", persistent: true }),
    ]);
    expect(result.program.operations[0]!.interval.end - result.program.operations[0]!.interval.start).toBeCloseTo(
      STUDIO_STYLE_PROFILE.durationSeconds.brief,
    );
    expect(result.program.provenance.styleProfileRef).toEqual(styleProfileRef(STUDIO_STYLE_PROFILE));
    const proposed = projectPersistentRemoveFixture(result.program, STUDIO_FIXTURE_SCENE, true);
    expect(
      projectProposedState(proposed, 5.5).canvas.entities.find((entity) => entity.id === "equation_1")?.present,
    ).toBe(false);
  });

  it("trims every Studio logical-group child through one parallel lifetime Program", () => {
    const firstId = "tx:first/entity:circle";
    const secondId = "tx:second/entity:circle";
    const firstScene = studioOwnedCircleScene(firstId, "first");
    const secondScene = studioOwnedCircleScene(secondId, "second");
    const scene = {
      ...firstScene,
      objectGraph: {
        ...firstScene.objectGraph,
        entities: {
          ...firstScene.objectGraph.entities,
          [secondId]: secondScene.objectGraph.entities[secondId]!,
        },
      },
    };
    const result = createStudioGroupLifetimeTrimProgram({
      capturedPlayhead: 7,
      childEntityIds: [firstId, secondId],
      scene,
      transactionId: "trim-logical-group",
    });

    expect(result.kind).toBe("valid");
    expect(result.program.intentCount).toBe(1);
    expect(result.program.requestedExecution).toBe("parallel");
    expect(result.program.operations).toEqual([
      expect.objectContaining({
        effect: "remove",
        entityId: firstId,
        interval: { end: 7, start: 7 },
        persistent: true,
      }),
      expect.objectContaining({
        effect: "remove",
        entityId: secondId,
        interval: { end: 7, start: 7 },
        persistent: true,
      }),
    ]);
    const group = createStudioGroupProgram({
      capturedPlayhead: 1,
      childEntityIds: [firstId, secondId],
      scene,
      transactionId: "logical-group",
    });
    expect(group.validation.kind).toBe("valid");
    const unavailableReason = (capturedPlayhead: number, programs = [group.validation.program], targetScene = scene) =>
      studioLogicalGroupLifetimeTrimUnavailableReason({
        capturedPlayhead,
        childEntityIds: [firstId, secondId],
        groupId: group.groupId,
        programs,
        scene: targetScene,
      });
    expect(unavailableReason(7)).toBeNull();
    expect(unavailableReason(7, [])).toMatch(/canonical Group Program is unavailable/i);
    expect(unavailableReason(1)).toMatch(/after the point where this logical group was created/i);
    expect(unavailableReason(1.05)).toMatch(/at least 0.1 seconds/i);
    expect(unavailableReason(scene.duration)).toMatch(/before the Scene end/i);
    expect(unavailableReason(7, [group.validation.program, result.program])).toMatch(/existing.*lifetime trim/i);
    expect(
      unavailableReason(7, [group.validation.program], {
        ...scene,
        objectGraph: {
          ...scene.objectGraph,
          entities: {
            ...scene.objectGraph.entities,
            [secondId]: {
              ...scene.objectGraph.entities[secondId]!,
              lifetime: [{ end: 6, start: 1 }],
            },
          },
        },
      }),
    ).toMatch(/every grouped object must be present/i);
    expect(() =>
      createStudioGroupLifetimeTrimProgram({
        capturedPlayhead: 1.05,
        childEntityIds: [firstId, secondId],
        scene,
        transactionId: "too-short-logical-group",
      }),
    ).toThrow(/at least 0.1 seconds/i);
    expect(() =>
      createStudioGroupLifetimeTrimProgram({
        capturedPlayhead: 7,
        childEntityIds: [firstId, "equation_1"],
        scene,
        transactionId: "imported-logical-group",
      }),
    ).toThrow(/only for Studio-created objects/i);
    expect(() =>
      createStudioGroupLifetimeTrimProgram({
        capturedPlayhead: scene.duration,
        childEntityIds: [firstId, secondId],
        scene,
        transactionId: "scene-end-logical-group",
      }),
    ).toThrow(/before the Scene end/i);
  });

  it("trims a lifetime through a persistent removal from a safe source anchor", () => {
    const result = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "trim-equation",
    });
    expect(result.kind).toBe("valid");
    expect(result.program.requestedExecution).toBe("sequence");
    expect(result.program.operations).toEqual([
      expect.objectContaining({
        effect: "remove",
        entityId: "equation_1",
        interval: { end: 7, start: 7 },
        kind: "ChangePresence",
        persistent: true,
      }),
    ]);

    const proposed = projectPersistentRemoveFixture(result.program);
    expect(proposed.evaluatedScene.objectGraph.entities.equation_1?.lifetime).toEqual([{ end: 7, start: 0 }]);
    expect(
      projectProposedState(proposed, 7.01).canvas.entities.find((entity) => entity.id === "equation_1")?.present,
    ).toBe(false);
  });

  it("rejects imported extension and a retained lifetime shorter than 0.1 seconds", () => {
    expect(() =>
      createImportedEntityLifetimeProgram({
        entityId: "arrow_1",
        original: { end: 9.5, start: 0 },
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 9.5,
        targetEnd: 10,
        transactionId: "extend-arrow",
      }),
    ).toThrow(/cannot extend beyond/i);
    expect(() =>
      createImportedEntityLifetimeProgram({
        entityId: "arrow_1",
        original: { end: 9.5, start: 0 },
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 0.05,
        targetEnd: 0.05,
        transactionId: "short-arrow",
      }),
    ).toThrow(/at least 0.1 seconds/i);
    expect(() =>
      createImportedEntityLifetimeProgram({
        entityId: "equation_1",
        original: { end: 12, start: 0 },
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 5,
        sourceAnchorBounds: { minimum: 7 },
        targetEnd: 5,
        transactionId: "out-of-order-imported-trim",
      }),
    ).toThrow(/out of source order/i);
  });

  it("replaces a Studio creation Program to edit both lifetime edges", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-owned-circle",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7],
      target: { end: 12, start: 7 },
    });

    expect(replacement.kind).toBe("valid");
    expect(replacement.program.transactionId).toBe("insert-owned-circle");
    expect(replacement.program.anchor.resolvedSeconds).toBe(7);
    expect(replacement.program.operations.find((operation) => operation.kind === "CreateEntity")).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ lifetime: { end: null, start: 7 } }),
      }),
    );
    expect(replacement.program.operations.map((operation) => operation.interval.start)).toEqual([7, 7, 7]);
    expect(() =>
      replaceStudioEntityLifetimeProgram({
        entityId: insertion.entityIds[0]!,
        owner,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchorBounds: { maximum: 5 },
        sourceAnchors: [5, 7],
        target: { end: 12, start: 7 },
      }),
    ).toThrow(/out of source order/i);
  });

  it("projects a finite Studio-owned lifetime back to its source endpoints", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-finite-circle",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7],
      target: { end: 7, start: 5 },
    });
    const evaluatedScene = studioOwnedCircleScene(insertion.entityIds[0]!, replacement.program.transactionId, {
      end: 7.4,
      start: 5,
    });
    expect(
      projectRuntimeSceneToSourceTimeline(evaluatedScene, [replacement.program]).objectGraph.entities[
        insertion.entityIds[0]!
      ]?.lifetime,
    ).toEqual([{ end: 7, start: 5 }]);
  });

  it("edits one end without moving a shared Studio creation Program", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: (["Circle", "Rectangle"] as const).map((type) => ({
        content: defaultEntityContent(type, ""),
        position: { x: 180, y: 120 },
        type,
      })),
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-shared-shapes",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7],
      target: { end: 7, start: 5 },
    });
    const lifetimes = replacement.program.operations.flatMap((operation) =>
      operation.kind === "CreateEntity" ? [operation.entity.lifetime] : [],
    );

    expect(replacement.kind).toBe("valid");
    expect(lifetimes).toEqual([
      { end: 7, start: 5 },
      { end: null, start: 5 },
    ]);
  });

  it("preserves a compound Program anchor for end-only edits", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-delayed-shape",
    });
    const rebased = rebaseProgramTime(insertion.validation.program, 2);
    const wait: CanonicalEditOperation = {
      dependsOn: [],
      eventKind: "wait",
      id: "insert-delayed-shape/operation/wait",
      interval: { end: 7, start: 5 },
      kind: "InsertTimelineEvent",
      label: "Wait before creation",
      provenance: { evidence: [], origin: "fixture" },
    };
    const delayedProgram = {
      ...rebased,
      anchor: insertion.validation.program.anchor,
      operations: [wait, ...rebased.operations],
      requestedExecution: "sequence" as const,
      schedule: {
        edges: [],
        mode: "sequence" as const,
        order: [wait.id, ...rebased.schedule.order],
      },
    };
    const owner = programRecord(delayedProgram, { issues: [], kind: "valid" });
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7, 9],
      target: { end: 9, start: 7 },
    });

    expect(replacement.kind).toBe("valid");
    expect(replacement.program.anchor.resolvedSeconds).toBe(5);
    expect(() =>
      replaceStudioEntityLifetimeProgram({
        entityId: insertion.entityIds[0]!,
        owner,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchors: [5, 7, 9],
        target: { end: 12, start: 9 },
      }),
    ).toThrow(/created after its Program begins/i);
  });

  it("replaces an imported end trim with a source-truthful restore", () => {
    const trimmed = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "imported-lifetime-equation",
    });
    expect(trimmed.program.operations[0]).toEqual(
      expect.objectContaining({
        effect: "remove",
        interval: { end: 7, start: 7 },
      }),
    );
    const restored = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      sourceAnchorBounds: { minimum: 9 },
      targetEnd: 12,
      transactionId: trimmed.program.transactionId,
    });
    expect(restored.program.operations[0]).toEqual(
      expect.objectContaining({
        eventKind: "wait",
        interval: { end: 7, start: 7 },
      }),
    );
    expect(restored.kind).toBe("valid");
  });

  it("extends the composition with an explicit source wait", () => {
    const result = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-duration",
    });
    expect(result.kind).toBe("valid");
    expect(result.program.operations[0]).toEqual(
      expect.objectContaining({
        eventKind: "wait",
        interval: { end: 10, start: 7 },
        purpose: "scene-duration",
      }),
    );
  });

  it("previews a shorter Scene by reducing only the trailing Studio duration wait", () => {
    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-before-trim",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const trim = createSceneDurationProgram({
      capturedPlayhead: 15,
      scene: { ...STUDIO_FIXTURE_SCENE, duration: 15 },
      sourceAnchor: 7,
      targetDuration: 14,
      transactionId: "trim-duration",
      trimAvailability: trimAvailability(extensionRecord.program.operations[0]!.id),
    });

    expect(trim.kind).toBe("valid");
    expect(trim.program.operations).toEqual([
      expect.objectContaining({
        kind: "TrimSceneDuration",
        removedDuration: 1,
        targetDuration: 14,
        waitOperationIds: [extension.program.operations[0]?.id],
      }),
    ]);
  });

  it("removes a Studio duration wait completely at the safe boundary", () => {
    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-to-delete",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const trim = createSceneDurationProgram({
      capturedPlayhead: 15,
      scene: { ...STUDIO_FIXTURE_SCENE, duration: 15 },
      sourceAnchor: 7,
      targetDuration: 12,
      transactionId: "delete-duration-wait",
      trimAvailability: trimAvailability(extensionRecord.program.operations[0]!.id),
    });
    expect(trim.kind).toBe("valid");
    expect(trim.program.operations[0]).toEqual(
      expect.objectContaining({
        kind: "TrimSceneDuration",
        removedDuration: 3,
        targetDuration: 12,
        waitOperationIds: [extension.program.operations[0]?.id],
      }),
    );
  });

  it("requires Rust trim availability and obeys its safe lower bound", () => {
    expect(() =>
      createSceneDurationProgram({
        capturedPlayhead: 12,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 7,
        targetDuration: 11,
        transactionId: "trim-imported-content",
      }),
    ).toThrow(/Rust timeline projection is required/i);

    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-before-later-edit",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const extendedScene = { ...STUDIO_FIXTURE_SCENE, duration: 15 };
    expect(() =>
      createSceneDurationProgram({
        capturedPlayhead: 15,
        scene: extendedScene,
        sourceAnchor: 7,
        targetDuration: 11,
        transactionId: "trim-too-far",
        trimAvailability: trimAvailability(extensionRecord.program.operations[0]!.id),
      }),
    ).toThrow(/shortest safe duration is 12\.00s/i);
  });
});
