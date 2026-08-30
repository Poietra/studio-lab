import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { drawInClipFromProgram, replaceDrawInProgram } from "./draw-in-edit";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  appendMaterialParameterKeyframe,
  appendMaterialRgbParameterKeyframe,
  type MaterialParameterKeyframe,
  materialParameterAssignmentBlocker,
  materialParameterIdentityEditBlocker,
  materialParameterKeyframeTracksFromProgram,
  materialRgbFromHexColor,
  materialRgbParameterKeyframeTrackFromProgram,
  materialRgbToHexColor,
  replaceMaterialParameterKeyframeProgram,
  replaceMaterialRgbParameterKeyframe,
  replaceMaterialRgbParameterKeyframeProgram,
} from "./material-parameter-keyframe-edit";
import { opacityKeyframeTrackFromProgram, replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";
import { buildStudioCreationProjectionCommand } from "./scene-authoring-wire";
import { type SceneEdit, sceneEditOperationSchema } from "./scene-edit-contract";
import { replaceWriteInProgram, writeInClipFromProgram } from "./write-in-edit";

const material = {
  parameters: [0.35, 8],
  revision: 1,
  shaderId: "project-wave",
} as const;

const rgbMaterial = {
  parameters: [0.35, 8, 0.2, 0.55, 1],
  revision: 1,
  shaderId: "project-gradient",
} as const;

describe("material parameter keyframe editing", () => {
  it("stores one named f32 track in the Studio creation Program without inserting Scene time", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-track",
    });
    const entityId = creation.entityIds[0]!;
    const result = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "ease-out", time: 2, value: 0.35 },
        { easing: "smooth", time: 4, value: 0.8 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(result.kind, JSON.stringify(result.issues)).toBe("valid");
    expect(result.program.loweringStatus).toBe("unsupported");
    expect(insertedProgramDuration(result.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(materialParameterKeyframeTracksFromProgram(result.program, 0)[0]).toMatchObject({
      entityId,
      keyframes: [
        { easing: "ease-out", time: 2, value: 0.35 },
        { easing: "smooth", time: 4, value: 0.8 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
    });
    const sourceKeyframes = materialParameterKeyframeTracksFromProgram(result.program, 0)[0]!.keyframes;
    const duplicated = replaceMaterialParameterKeyframeProgram({
      baseProgram: result.program,
      entityId,
      keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, 3),
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(materialParameterKeyframeTracksFromProgram(duplicated.program, 0)[0]?.keyframes).toEqual([
      { easing: "ease-out", time: 2, value: 0.35 },
      { easing: "smooth", time: 3, value: 0.8 },
      { easing: "smooth", time: 4, value: 0.8 },
    ]);
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: result.program,
        entityId,
        keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, STUDIO_FIXTURE_SCENE.duration + 1),
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/inside the Scene/i);
    const removed = replaceMaterialParameterKeyframeProgram({
      baseProgram: result.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.program.loweringStatus).toBe("supported");
    expect(removed.program.provenance.evidence).not.toContain("Studio material f32 parameter keyframes");
    expect(materialParameterKeyframeTracksFromProgram(removed.program, 0)).toEqual([]);
  });

  it("edits and removes one material parameter track without changing its sibling", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-tracks",
    });
    const entityId = creation.entityIds[0]!;
    const withSpeed = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "ease-out", time: 2, value: 0.35 },
        { easing: "linear", time: 4, value: 0.75 },
      ],
      material,
      name: "Speed",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    const withBands = replaceMaterialParameterKeyframeProgram({
      baseProgram: withSpeed.program,
      entityId,
      keyframes: [
        { easing: "linear", time: 2.5, value: 8 },
        { easing: "smooth", time: 4.5, value: 12 },
      ],
      material,
      name: "Bands",
      parameterIndex: 1,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(withBands.kind, JSON.stringify(withBands.issues)).toBe("valid");
    expect(materialParameterKeyframeTracksFromProgram(withBands.program, 0)).toMatchObject([
      { name: "Speed", parameterIndex: 0 },
      { name: "Bands", parameterIndex: 1 },
    ]);
    expect(withBands.program.operations.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("material-parameter-0-segment-0"),
        expect.stringContaining("material-parameter-1-segment-0"),
      ]),
    );
    const bandsOperations = withBands.program.operations.filter(
      (operation) => operation.kind === "AnimateProperty" && operation.materialParameter?.parameterIndex === 1,
    );
    const editedSpeed = replaceMaterialParameterKeyframeProgram({
      baseProgram: withBands.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 0.35 },
        { easing: "ease-in", time: 3.5, value: 0.9 },
      ],
      material,
      name: "Speed",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(editedSpeed.kind, JSON.stringify(editedSpeed.issues)).toBe("valid");
    expect(
      JSON.stringify(
        editedSpeed.program.operations.filter(
          (operation) => operation.kind === "AnimateProperty" && operation.materialParameter?.parameterIndex === 1,
        ),
      ),
    ).toBe(JSON.stringify(bandsOperations));

    const withoutSpeed = replaceMaterialParameterKeyframeProgram({
      baseProgram: editedSpeed.program,
      entityId,
      keyframes: [],
      material,
      name: "Speed",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(withoutSpeed.kind, JSON.stringify(withoutSpeed.issues)).toBe("valid");
    expect(
      JSON.stringify(
        withoutSpeed.program.operations.filter(
          (operation) => operation.kind === "AnimateProperty" && operation.materialParameter?.parameterIndex === 1,
        ),
      ),
    ).toBe(JSON.stringify(bandsOperations));
    expect(materialParameterKeyframeTracksFromProgram(withoutSpeed.program, 0)).toMatchObject([
      { name: "Bands", parameterIndex: 1 },
    ]);
    expect(withoutSpeed.program.provenance.evidence).toContain("Studio material f32 parameter keyframes");
  });

  it("round-trips one logical RGB track through three scalar operations while preserving its scalar sibling", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-rgb-track",
    });
    const entityId = creation.entityIds[0]!;
    const withSpeed = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 0.35 },
        { easing: "linear", time: 4, value: 0.8 },
      ],
      material: rgbMaterial,
      name: "Speed",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    const scalarOperations = withSpeed.program.operations.filter(
      (operation) => operation.kind === "AnimateProperty" && operation.materialParameter?.parameterIndex === 0,
    );
    const target = { entityId, material: rgbMaterial, name: "Cool", parameterIndex: 2 } as const;
    const withRgb = replaceMaterialRgbParameterKeyframeProgram({
      ...target,
      baseProgram: withSpeed.program,
      keyframes: [
        { easing: "ease-out", time: 2.5, value: [0.2, 0.55, 1] },
        { easing: "smooth", time: 4.5, value: [1, 0.3, 0.65] },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(withRgb.kind, JSON.stringify(withRgb.issues)).toBe("valid");
    expect(materialRgbParameterKeyframeTrackFromProgram(withRgb.program, 0, target)).toMatchObject({
      ...target,
      keyframes: [
        { easing: "ease-out", time: 2.5, value: [0.2, 0.55, 1] },
        { easing: "smooth", time: 4.5, value: [1, 0.3, 0.65] },
      ],
      parameterType: "rgb",
    });
    const componentMetadata = withRgb.program.operations.flatMap((operation) =>
      operation.kind === "AnimateProperty" && operation.materialParameter?.rgbComponent
        ? [
            {
              parameterIndex: operation.materialParameter.parameterIndex,
              rgbComponent: operation.materialParameter.rgbComponent,
            },
          ]
        : [],
    );
    expect(componentMetadata).toEqual([
      { parameterIndex: 2, rgbComponent: "r" },
      { parameterIndex: 3, rgbComponent: "g" },
      { parameterIndex: 4, rgbComponent: "b" },
    ]);
    const persisted = sceneEditOperationSchema.parse(
      withRgb.program.operations.find(
        (operation) => operation.kind === "AnimateProperty" && operation.materialParameter?.rgbComponent === "g",
      ),
    );
    expect(persisted.kind === "AnimateProperty" ? persisted.materialParameter?.rgbComponent : null).toBe("g");
    const wire = buildStudioCreationProjectionCommand({
      baseDuration: STUDIO_FIXTURE_SCENE.duration,
      programs: [withRgb.program],
    });
    const rgbWireOperations = wire.programs[0]!.operations.filter(
      (operation) => operation.kind === "material-parameter-keyframes" && operation.parameterIndex >= 2,
    );
    expect(rgbWireOperations).toHaveLength(3);
    expect(rgbWireOperations.every((operation) => !("rgbComponent" in operation))).toBe(true);

    const logical = materialRgbParameterKeyframeTrackFromProgram(withRgb.program, 0, target)!;
    const edited = replaceMaterialRgbParameterKeyframeProgram({
      ...target,
      baseProgram: withRgb.program,
      keyframes: replaceMaterialRgbParameterKeyframe(logical.keyframes, 1, {
        easing: "ease-in",
        time: 4,
        value: [0.1, 0.4, 0.8],
      }),
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(
      edited.program.operations.filter(
        (operation) => operation.kind === "AnimateProperty" && operation.materialParameter?.parameterIndex === 0,
      ),
    ).toEqual(scalarOperations);
    expect(materialRgbParameterKeyframeTrackFromProgram(edited.program, 0, target)?.keyframes[1]).toEqual({
      easing: "smooth",
      time: 4,
      value: [0.1, 0.4, 0.8],
    });
    expect(materialRgbToHexColor([1, 0.3, 0.65])).toBe("#ff4da6");
    expect(materialRgbFromHexColor("#ff4da6")).toEqual([1, 77 / 255, 166 / 255]);
    expect(appendMaterialRgbParameterKeyframe(logical.keyframes, 5, [0.2, 0.55, 1])).toHaveLength(3);

    const removed = replaceMaterialRgbParameterKeyframeProgram({
      ...target,
      baseProgram: edited.program,
      keyframes: [],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(materialRgbParameterKeyframeTrackFromProgram(removed.program, 0, target)).toBeNull();
    expect(materialParameterKeyframeTracksFromProgram(removed.program, 0)).toMatchObject([
      { name: "Speed", parameterIndex: 0 },
    ]);
    expect(removed.program.provenance.evidence).toContain("Studio material f32 parameter keyframes");
  });

  it("rejects partial or desynchronized RGB components before editing or preview compilation", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-rgb-corrupt",
    });
    const entityId = creation.entityIds[0]!;
    const target = { entityId, material: rgbMaterial, name: "Cool", parameterIndex: 2 } as const;
    const complete = replaceMaterialRgbParameterKeyframeProgram({
      ...target,
      baseProgram: creation.validation.program,
      keyframes: [
        { easing: "smooth", time: 2, value: [0.2, 0.55, 1] },
        { easing: "linear", time: 4, value: [1, 0.3, 0.65] },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });
    const partial = {
      ...complete.program,
      operations: complete.program.operations.filter(
        (operation) => operation.kind !== "AnimateProperty" || operation.materialParameter?.rgbComponent !== "b",
      ),
    } as SceneEdit;
    expect(() => materialRgbParameterKeyframeTrackFromProgram(partial, 0, target)).toThrow(/exactly r, g, and b/i);
    expect(() =>
      replaceMaterialRgbParameterKeyframeProgram({
        ...target,
        baseProgram: partial,
        keyframes: [],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/exactly r, g, and b/i);
    expect(materialParameterAssignmentBlocker([partial], { [entityId]: rgbMaterial })).toMatch(/RGB.*r, g, and b/i);

    const desynchronized = {
      ...complete.program,
      operations: complete.program.operations.map((operation) =>
        operation.kind === "AnimateProperty" && operation.materialParameter?.rgbComponent === "g"
          ? { ...operation, easing: "ease-in" as const }
          : operation,
      ),
    } as SceneEdit;
    expect(() => materialRgbParameterKeyframeTrackFromProgram(desynchronized, 0, target)).toThrow(
      /identical keyframe times and easing/i,
    );
    expect(materialParameterAssignmentBlocker([desynchronized], { [entityId]: rgbMaterial })).toMatch(
      /identical keyframe times and easing/i,
    );
  });

  it("coexists with opacity and fails closed when the assigned material changes", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-and-opacity",
    });
    const entityId = creation.entityIds[0]!;
    const withOpacity = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 1 },
        { easing: "linear", time: 4, value: 0.5 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });
    const withBoth = replaceMaterialParameterKeyframeProgram({
      baseProgram: withOpacity.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2.5, value: 0.35 },
        { easing: "linear", time: 4.5, value: 0.7 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(withBoth.kind, JSON.stringify(withBoth.issues)).toBe("valid");
    expect(opacityKeyframeTrackFromProgram(withBoth.program, 0)).not.toBeNull();
    expect(materialParameterKeyframeTracksFromProgram(withBoth.program, 0)).toHaveLength(1);
    expect(materialParameterAssignmentBlocker([withBoth.program], { [entityId]: material })).toBeNull();
    expect(
      materialParameterAssignmentBlocker([withBoth.program], {
        [entityId]: { ...material, revision: 2 },
      }),
    ).toMatch(/no longer matches/i);
    expect(materialParameterAssignmentBlocker([withBoth.program], {})).toMatch(/restore that material/i);
    const opacityOnly = replaceMaterialParameterKeyframeProgram({
      baseProgram: withBoth.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(opacityOnly.program.loweringStatus).toBe("unsupported");
    expect(opacityOnly.program.provenance.evidence).not.toContain("Studio material f32 parameter keyframes");
    expect(opacityKeyframeTrackFromProgram(opacityOnly.program, 0)).not.toBeNull();
  });

  it("rejects stale material identity and changing the fixed baseline marker", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-stale",
    });
    const entityId = creation.entityIds[0]!;
    const first = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 2, value: 0.35 }],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: first.program,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: 0.5 }],
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/first material keyframe/i);
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: first.program,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: 0.4 }],
        material: { ...material, parameters: [0.4, 8], revision: 2 },
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/one object and material/i);

    const recovered = replaceMaterialParameterKeyframeProgram({
      baseProgram: first.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(recovered.kind, JSON.stringify(recovered.issues)).toBe("valid");
    expect(materialParameterKeyframeTracksFromProgram(recovered.program, 0)).toEqual([]);
  });

  it("keeps keyframe insertion append-only and composes a Line material track with Draw in either order", () => {
    expect(() => appendMaterialParameterKeyframe([{ easing: "smooth", time: 3, value: 0.35 }], 2.5, 0.35)).toThrow(
      /after the final marker/i,
    );
    expect(appendMaterialParameterKeyframe([{ easing: "smooth", time: 3, value: 0.6 }], 4, 0.35)).toEqual([
      { easing: "smooth", time: 3, value: 0.6 },
      { easing: "smooth", time: 4, value: 0.6 },
    ]);

    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Line" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-entrance-guard",
    });
    const entityId = creation.entityIds[0]!;
    const drawEnd = 2.5;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: drawEnd },
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    const drawThenKeyframes = replaceMaterialParameterKeyframeProgram({
      baseProgram: drawn.program,
      entityId,
      fragmentMaterial: { texture: false },
      keyframes: [
        { easing: "smooth", time: 1.25, value: 0.35 },
        { easing: "linear", time: 2, value: 0.7 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawThenKeyframes.kind, JSON.stringify(drawThenKeyframes.issues)).toBe("valid");
    expect(drawInClipFromProgram(drawThenKeyframes.program)?.interval.end).toBe(drawEnd);
    expect(materialParameterKeyframeTracksFromProgram(drawThenKeyframes.program, 0)[0]?.keyframes).toHaveLength(2);

    const edited = replaceMaterialParameterKeyframeProgram({
      baseProgram: drawThenKeyframes.program,
      entityId,
      fragmentMaterial: { texture: false },
      keyframes: [
        { easing: "smooth", time: 1.25, value: 0.35 },
        { easing: "ease-out", time: 2.25, value: 0.9 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(edited.kind, JSON.stringify(edited.issues)).toBe("valid");
    const removedTrack = replaceMaterialParameterKeyframeProgram({
      baseProgram: edited.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawInClipFromProgram(removedTrack.program)).not.toBeNull();
    expect(materialParameterKeyframeTracksFromProgram(removedTrack.program, 0)).toEqual([]);

    const keyframesFirst = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 0.35 },
        { easing: "linear", time: 3, value: 0.7 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    const keyframesThenDraw = replaceDrawInProgram({
      baseProgram: keyframesFirst.program,
      draw: { easing: "smooth", end: drawEnd },
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(keyframesThenDraw.kind, JSON.stringify(keyframesThenDraw.issues)).toBe("valid");
    expect(drawInClipFromProgram(keyframesThenDraw.program)).not.toBeNull();
    expect(materialParameterKeyframeTracksFromProgram(keyframesThenDraw.program, 0)).toHaveLength(1);
  });

  it("requires material admission and rejects texture parameter tracks when Draw exists", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Line" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-draw-recovery",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: 2 },
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: drawn.program,
        entityId,
        keyframes: [{ easing: "smooth", time: 2.5, value: 0.35 }],
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/metadata/);
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: drawn.program,
        entityId,
        fragmentMaterial: { texture: true },
        keyframes: [{ easing: "smooth", time: 2.5, value: 0.35 }],
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/texture/);
  });

  it("composes MathTex Write with later texture-free material keyframes in either order", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          content: { displayLines: [String.raw`E = mc^2`], texParts: [String.raw`E = mc^2`] },
          position: { x: 320, y: 180 },
          type: "MathTex",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-after-write",
    });
    const entityId = creation.entityIds[0]!;
    const written = replaceWriteInProgram({
      baseProgram: creation.validation.program,
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
      write: { easing: "linear", end: 2.5 },
    });
    const parameterFirstKeyframes = [
      { easing: "smooth" as const, time: 3, value: 0.35 },
      { easing: "linear" as const, time: 4, value: 0.8 },
    ];
    const writeThenParameterKeyframes = [
      { easing: "smooth" as const, time: 1.1, value: 0.35 },
      { easing: "linear" as const, time: 2, value: 0.8 },
    ];
    const replaceTrack = (
      baseProgram: SceneEdit,
      nextKeyframes: readonly MaterialParameterKeyframe[],
      texture = false,
    ) =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram,
        entityId,
        fragmentMaterial: { texture },
        keyframes: nextKeyframes,
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      });
    const replaceWrite = (baseProgram: SceneEdit, end: number | null, texture: boolean | null = false) =>
      replaceWriteInProgram({
        baseProgram,
        entityId,
        fragmentMaterial: texture === null ? null : { texture },
        scene: STUDIO_FIXTURE_SCENE,
        write: end === null ? null : { easing: "linear", end },
      });

    expect(() => replaceTrack(written.program, [{ ...writeThenParameterKeyframes[0]!, time: 1 }])).toThrow(
      /initial entrance/i,
    );
    const tracked = replaceTrack(written.program, writeThenParameterKeyframes);
    expect(tracked.kind, JSON.stringify(tracked.issues)).toBe("valid");
    expect(
      tracked.program.operations.flatMap((operation) =>
        operation.kind === "AnimateProperty" && operation.materialParameter ? [operation.entityId] : [],
      ),
    ).toEqual([entityId]);

    const parameterFirst = replaceTrack(creation.validation.program, parameterFirstKeyframes);
    expect(() => replaceWrite(parameterFirst.program, 2.5, null)).toThrow(/metadata/i);
    const recomposed = replaceWrite(parameterFirst.program, 2.5);
    expect(writeInClipFromProgram(recomposed.program)?.interval.end).toBe(2.5);
    expect(() => replaceWrite(recomposed.program, 4.5)).toThrow(/before the first material parameter keyframe/i);
    expect(() => replaceTrack(written.program, writeThenParameterKeyframes, true)).toThrow(/texture/);

    const recoveredTrack = replaceTrack(tracked.program, [], true);
    expect(writeInClipFromProgram(recoveredTrack.program)).not.toBeNull();
    expect(materialParameterKeyframeTracksFromProgram(recoveredTrack.program, 0)).toEqual([]);
    const recoveredWrite = replaceWrite(recomposed.program, null, true);
    expect(writeInClipFromProgram(recoveredWrite.program)).toBeNull();
    expect(materialParameterKeyframeTracksFromProgram(recoveredWrite.program, 0)).toHaveLength(1);
  });

  it("blocks material identity edits only while a matching active track exists", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-identity-guard",
    });
    const entityId = creation.entityIds[0]!;
    const tracked = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 2, value: 0.35 }],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(materialParameterIdentityEditBlocker([tracked.program], { entityId })).toMatch(/remove.*track/i);
    expect(materialParameterIdentityEditBlocker([tracked.program], { shaderId: material.shaderId })).toMatch(
      /remove.*track/i,
    );
    expect(materialParameterIdentityEditBlocker([tracked.program], { shaderId: "other" })).toBeNull();
  });
});
