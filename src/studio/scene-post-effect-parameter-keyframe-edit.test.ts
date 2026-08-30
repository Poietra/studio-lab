import { describe, expect, it } from "vitest";

import { createStudioScenePostEffectProgram } from "./authoring-commands";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE, validateMotionProgramFixture } from "./fixture";
import {
  insertScenePostEffectParameterKeyframe,
  removeScenePostEffectParameterKeyframe,
  replaceScenePostEffectParameterKeyframe,
  replaceScenePostEffectParameterKeyframeProgram,
  replaceScenePostEffectRgbParameterKeyframeProgram,
  type ScenePostEffectRgbParameterKeyframe,
  type ScenePostEffectRgbParameterTarget,
  scenePostEffectParameterKeyframesToSourceTime,
  scenePostEffectParameterTrackMatchesEffects,
  scenePostEffectParameterTracksMatchEffects,
  scenePostEffectParameterTracksToWorkingTime,
  scenePostEffectParameterTrackToWorkingTime,
  scenePostEffectRgbParameterKeyframesToSourceTime,
  scenePostEffectRgbParameterTrackFromScalarTracks,
} from "./scene-post-effect-parameter-keyframe-edit";

const effect = { parameters: [4, 2, 1, 0], revision: 1, shaderId: "rgb-split" } as const;
const rgbEffect = { parameters: [4, 0.2, 0.55, 1], revision: 1, shaderId: "rgb-split" } as const;

function owner(sceneEffect: typeof effect | typeof rgbEffect = effect) {
  const validation = createStudioScenePostEffectProgram({
    capturedPlayhead: 0,
    effects: [sceneEffect],
    scene: STUDIO_FIXTURE_SCENE,
    transactionId: "scene-effect-track",
  });
  return programRecord(validation.program, validation);
}

function parameterTracks(program: ReturnType<typeof owner>["program"]) {
  const operation = program.operations[0];
  return operation?.kind === "SetScenePostEffect" ? operation.parameterTracks : [];
}

function parameterTrack(program: ReturnType<typeof owner>["program"], parameterIndex = 0) {
  return parameterTracks(program).find((track) => track.parameterIndex === parameterIndex) ?? null;
}

const rgbTarget = {
  baseline: [0.2, 0.55, 1],
  name: "Tint",
  parameterIndex: 1,
  revision: 1,
  shaderId: "rgb-split",
} as const satisfies ScenePostEffectRgbParameterTarget;

const rgbKeyframes: readonly ScenePostEffectRgbParameterKeyframe[] = [
  { easing: "smooth", time: 0, value: [0.2, 0.55, 1] },
  { easing: "linear", time: 2, value: [1, 0.25, 0.5] },
];

function legacyInsertionProgram() {
  const validation = validateMotionProgramFixture({
    capturedPlayhead: 1,
    controlOffset: { x: 20, y: 10 },
    delta: { x: 40, y: 20 },
    interval: { end: 2, start: 1 },
    scene: STUDIO_FIXTURE_SCENE,
    targetEntityIds: ["equation_1"],
    transactionId: "legacy-insertion",
  });
  if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
  return validation.program;
}

describe("Scene post-effect parameter keyframe editing", () => {
  it("stores one scalar track in the existing Scene effect Program", () => {
    const first = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 1, value: 4 },
        { easing: "smooth", time: 2, value: 4 },
      ],
      name: "Offset",
      owner: owner(),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    expect(first.kind, JSON.stringify(first.issues)).toBe("valid");
    expect(parameterTrack(first.program)).toMatchObject({
      keyframes: [
        { easing: "smooth", time: 1, value: 4 },
        { easing: "smooth", time: 2, value: 4 },
      ],
      name: "Offset",
      parameterIndex: 0,
      revision: 1,
      shaderId: "rgb-split",
    });

    const keyframes = insertScenePostEffectParameterKeyframe(parameterTrack(first.program)!.keyframes, 3, 4);
    const animated = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: replaceScenePostEffectParameterKeyframe(keyframes, 2, { easing: "linear", value: 12 }),
      name: "Offset",
      owner: programRecord(first.program, first),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    expect(parameterTrack(animated.program)?.keyframes).toEqual([
      { easing: "smooth", time: 1, value: 4 },
      { easing: "smooth", time: 2, value: 4 },
      { easing: "linear", time: 3, value: 12 },
    ]);
    const removed = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [],
      name: "Offset",
      owner: programRecord(animated.program, animated),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    expect(parameterTrack(removed.program)).toBeNull();
  });

  it("adds, updates, and removes one target without changing sibling parameter tracks", () => {
    const offset = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 1, value: 4 },
        { easing: "linear", time: 2, value: 8 },
      ],
      name: "Offset",
      owner: owner(),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    const strength = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 0, value: 2 },
        { easing: "ease-in", time: 3, value: 6 },
      ],
      name: "Strength",
      owner: programRecord(offset.program, offset),
      parameterIndex: 1,
      range: { max: 10, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });

    expect(parameterTracks(strength.program)).toHaveLength(2);
    expect(parameterTrack(strength.program, 0)?.keyframes[1]?.value).toBe(8);
    expect(parameterTrack(strength.program, 1)?.keyframes[1]?.value).toBe(6);

    const updated = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 1, value: 4 },
        { easing: "ease-out", time: 2.5, value: 12 },
      ],
      name: "Offset",
      owner: programRecord(strength.program, strength),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    expect(parameterTrack(updated.program, 0)?.keyframes[1]).toEqual({ easing: "ease-out", time: 2.5, value: 12 });
    expect(parameterTrack(updated.program, 1)).toEqual(parameterTrack(strength.program, 1));

    const removed = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [],
      name: "Offset",
      owner: programRecord(updated.program, updated),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    expect(parameterTracks(removed.program)).toEqual([parameterTrack(strength.program, 1)]);
  });

  it("atomically adds, updates, reconstructs, and removes one logical RGB track", () => {
    const scalar = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 0, value: 4 },
        { easing: "linear", time: 2, value: 8 },
      ],
      name: "Strength",
      owner: owner(rgbEffect),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    const added = replaceScenePostEffectRgbParameterKeyframeProgram({
      keyframes: rgbKeyframes,
      name: rgbTarget.name,
      owner: programRecord(scalar.program, scalar),
      parameterIndex: rgbTarget.parameterIndex,
      revision: rgbTarget.revision,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: rgbTarget.shaderId,
    });

    expect(added.kind, JSON.stringify(added.issues)).toBe("valid");
    expect(parameterTracks(added.program).map(({ parameterIndex }) => parameterIndex)).toEqual([0, 1, 2, 3]);
    expect(scenePostEffectRgbParameterTrackFromScalarTracks(parameterTracks(added.program), rgbTarget)).toEqual({
      keyframes: rgbKeyframes,
      name: "Tint",
      parameterIndex: 1,
      revision: 1,
      shaderId: "rgb-split",
    });
    expect(parameterTrack(added.program, 0)).toEqual(parameterTrack(scalar.program, 0));

    const updatedKeyframes = replaceScenePostEffectParameterKeyframe(rgbKeyframes, 1, {
      easing: "ease-out",
      value: [0.75, 0.5, 0.25],
    });
    const updated = replaceScenePostEffectRgbParameterKeyframeProgram({
      keyframes: updatedKeyframes,
      name: rgbTarget.name,
      owner: programRecord(added.program, added),
      parameterIndex: rgbTarget.parameterIndex,
      revision: rgbTarget.revision,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: rgbTarget.shaderId,
    });
    expect(
      scenePostEffectRgbParameterTrackFromScalarTracks(parameterTracks(updated.program), rgbTarget)?.keyframes,
    ).toEqual(updatedKeyframes);
    expect(parameterTrack(updated.program, 0)).toEqual(parameterTrack(scalar.program, 0));

    const removed = replaceScenePostEffectRgbParameterKeyframeProgram({
      keyframes: [],
      name: rgbTarget.name,
      owner: programRecord(updated.program, updated),
      parameterIndex: rgbTarget.parameterIndex,
      revision: rgbTarget.revision,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: rgbTarget.shaderId,
    });
    expect(parameterTracks(removed.program)).toEqual([parameterTrack(scalar.program, 0)]);
    expect(scenePostEffectRgbParameterTrackFromScalarTracks(parameterTracks(removed.program), rgbTarget)).toBeNull();
  });

  it("rejects partial, desynchronized, stale-baseline, and invalid RGB component tracks", () => {
    const partial = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 0, value: 0.2 },
        { easing: "linear", time: 2, value: 1 },
      ],
      name: "Tint",
      owner: owner(rgbEffect),
      parameterIndex: 1,
      range: { max: 1, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    expect(() => scenePostEffectRgbParameterTrackFromScalarTracks(parameterTracks(partial.program), rgbTarget)).toThrow(
      /exactly three complete/u,
    );
    expect(() =>
      replaceScenePostEffectRgbParameterKeyframeProgram({
        keyframes: rgbKeyframes,
        name: rgbTarget.name,
        owner: programRecord(partial.program, partial),
        parameterIndex: rgbTarget.parameterIndex,
        revision: rgbTarget.revision,
        scene: STUDIO_FIXTURE_SCENE,
        shaderId: rgbTarget.shaderId,
      }),
    ).toThrow(/exactly three complete/u);

    const components = [
      {
        index: 1,
        keyframes: [
          { easing: "smooth" as const, time: 0, value: 0.2 },
          { easing: "linear" as const, time: 2, value: 1 },
        ],
      },
      {
        index: 2,
        keyframes: [
          { easing: "smooth" as const, time: 0, value: 0.55 },
          { easing: "linear" as const, time: 2.5, value: 0.25 },
        ],
      },
      {
        index: 3,
        keyframes: [
          { easing: "smooth" as const, time: 0, value: 1 },
          { easing: "linear" as const, time: 2, value: 0.5 },
        ],
      },
    ];
    let desynchronizedOwner = owner(rgbEffect);
    for (const component of components) {
      const result = replaceScenePostEffectParameterKeyframeProgram({
        keyframes: component.keyframes,
        name: "Tint",
        owner: desynchronizedOwner,
        parameterIndex: component.index,
        range: { max: 1, min: 0 },
        revision: 1,
        scene: STUDIO_FIXTURE_SCENE,
        shaderId: "rgb-split",
      });
      desynchronizedOwner = programRecord(result.program, result);
    }
    expect(() =>
      scenePostEffectRgbParameterTrackFromScalarTracks(parameterTracks(desynchronizedOwner.program), rgbTarget),
    ).toThrow(/identical keyframe times and easing/u);

    const aligned = replaceScenePostEffectRgbParameterKeyframeProgram({
      keyframes: rgbKeyframes,
      name: rgbTarget.name,
      owner: owner(rgbEffect),
      parameterIndex: rgbTarget.parameterIndex,
      revision: rgbTarget.revision,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: rgbTarget.shaderId,
    });
    expect(() =>
      scenePostEffectRgbParameterTrackFromScalarTracks(parameterTracks(aligned.program), {
        ...rgbTarget,
        baseline: [0.21, 0.55, 1],
      }),
    ).toThrow(/preserve the static parameter value/u);
    expect(() =>
      replaceScenePostEffectRgbParameterKeyframeProgram({
        keyframes: [rgbKeyframes[0], { ...rgbKeyframes[1], value: [1.01, 0.25, 0.5] }],
        name: rgbTarget.name,
        owner: programRecord(aligned.program, aligned),
        parameterIndex: rgbTarget.parameterIndex,
        revision: rgbTarget.revision,
        scene: STUDIO_FIXTURE_SCENE,
        shaderId: rgbTarget.shaderId,
      }),
    ).toThrow(/finite unit colors/u);
  });

  it("rejects stale identity, a changed baseline, and invalid keyframe order", () => {
    const base = owner();
    const input = {
      name: "Offset",
      owner: base,
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    } as const;
    expect(() =>
      replaceScenePostEffectParameterKeyframeProgram({
        ...input,
        keyframes: [
          { easing: "smooth", time: 1, value: 5 },
          { easing: "smooth", time: 2, value: 6 },
        ],
      }),
    ).toThrow(/static parameter value/u);
    expect(() =>
      replaceScenePostEffectParameterKeyframeProgram({
        ...input,
        keyframes: [
          { easing: "smooth", time: 2, value: 4 },
          { easing: "linear", time: 1, value: 8 },
        ],
      }),
    ).toThrow(/ordered/u);
    expect(() =>
      replaceScenePostEffectParameterKeyframeProgram({
        ...input,
        keyframes: [
          { easing: "smooth", time: 1, value: 4 },
          { easing: "smooth", time: STUDIO_FIXTURE_SCENE.duration + 1, value: 4 },
        ],
      }),
    ).toThrow(/inside the Scene/u);
    expect(() =>
      replaceScenePostEffectParameterKeyframeProgram({
        ...input,
        keyframes: [{ easing: "smooth", time: 1, value: 4 }],
      }),
    ).toThrow(/ordered/u);
  });

  it("inserts at the playhead in time order without evaluating the curve in TypeScript", () => {
    expect(
      insertScenePostEffectParameterKeyframe(
        [
          { easing: "smooth", time: 1, value: 4 },
          { easing: "linear", time: 3, value: 12 },
        ],
        2,
        20,
      ),
    ).toEqual([
      { easing: "smooth", time: 1, value: 4 },
      { easing: "smooth", time: 2, value: 4 },
      { easing: "linear", time: 3, value: 12 },
    ]);
    expect(insertScenePostEffectParameterKeyframe([{ easing: "linear", time: 1, value: 8 }], 0.5, 20)).toEqual([
      { easing: "smooth", time: 0.5, value: 8 },
      { easing: "linear", time: 1, value: 8 },
    ]);
    expect(insertScenePostEffectParameterKeyframe([], 1, 20)).toEqual([{ easing: "smooth", time: 1, value: 20 }]);
    expect(() => insertScenePostEffectParameterKeyframe([{ easing: "smooth", time: 2, value: 4 }], 2.0004, 20)).toThrow(
      /already exists/u,
    );

    const rgbInserted = insertScenePostEffectParameterKeyframe(rgbKeyframes, 1, rgbTarget.baseline);
    expect(rgbInserted[1]).toEqual({ easing: "smooth", time: 1, value: [0.2, 0.55, 1] });
    expect(removeScenePostEffectParameterKeyframe(rgbInserted, 1)).toEqual(rgbKeyframes);
  });

  it("keeps the baseline marker deletion rule explicit", () => {
    expect(() =>
      removeScenePostEffectParameterKeyframe(
        [
          { easing: "smooth", time: 1, value: 4 },
          { easing: "linear", time: 2, value: 8 },
        ],
        0,
      ),
    ).toThrow(/cannot be removed alone/u);
    expect(removeScenePostEffectParameterKeyframe([{ easing: "smooth", time: 1, value: 4 }], 0)).toEqual([]);
  });

  it("blocks stack changes that invalidate the animated parameter baseline", () => {
    const result = replaceScenePostEffectParameterKeyframeProgram({
      keyframes: [
        { easing: "smooth", time: 1, value: 4 },
        { easing: "linear", time: 2, value: 8 },
      ],
      name: "Offset",
      owner: owner(),
      parameterIndex: 0,
      range: { max: 20, min: 0 },
      revision: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shaderId: "rgb-split",
    });
    const track = parameterTrack(result.program);

    expect(scenePostEffectParameterTrackMatchesEffects(track, [effect])).toBe(true);
    expect(scenePostEffectParameterTrackMatchesEffects(track, [{ ...effect, parameters: [4.0004, 2, 1, 0] }])).toBe(
      true,
    );
    expect(scenePostEffectParameterTrackMatchesEffects(track, [{ ...effect, parameters: [4.001, 2, 1, 0] }])).toBe(
      false,
    );
    expect(scenePostEffectParameterTrackMatchesEffects(track, [])).toBe(false);
    expect(scenePostEffectParameterTracksMatchEffects([track!], [effect])).toBe(true);
    expect(scenePostEffectParameterTracksMatchEffects([track!], [])).toBe(false);
    expect(scenePostEffectParameterTracksMatchEffects([], [])).toBe(true);
  });

  it("keeps stored markers in source time while projecting InsertWait into the working timeline", () => {
    const track = {
      keyframes: [
        { easing: "smooth" as const, time: 0.5, value: 4 },
        { easing: "linear" as const, time: 1.5, value: 8 },
      ],
      name: "Offset",
      parameterIndex: 0,
      revision: 1,
      shaderId: "rgb-split",
    };
    const transforms = [
      {
        interval: { end: 2, start: 1 },
        kind: "insert" as const,
        operationId: "insert-wait",
      },
    ];
    const authority = { programs: [], timelineTransforms: transforms };
    const working = scenePostEffectParameterTrackToWorkingTime(track, authority);

    expect(working.keyframes.map(({ time }) => time)).toEqual([0.5, 2.5]);
    expect(scenePostEffectParameterKeyframesToSourceTime(working.keyframes, authority)).toEqual(track.keyframes);
    expect(track.keyframes.map(({ time }) => time)).toEqual([0.5, 1.5]);
    expect(scenePostEffectParameterTracksToWorkingTime([track, { ...track, parameterIndex: 1 }], authority)).toEqual([
      working,
      { ...working, parameterIndex: 1 },
    ]);
    expect(scenePostEffectRgbParameterKeyframesToSourceTime([{ ...rgbKeyframes[1], time: 2.5 }], authority)).toEqual([
      { ...rgbKeyframes[1], time: 1.5 },
    ]);
  });

  it("uses the legacy Program composition mapping when no Rust timeline transform exists", () => {
    const track = {
      keyframes: [
        { easing: "smooth" as const, time: 0.5, value: 4 },
        { easing: "linear" as const, time: 1.5, value: 8 },
      ],
      name: "Offset",
      parameterIndex: 0,
      revision: 1,
      shaderId: "rgb-split",
    };
    const authority = { programs: [legacyInsertionProgram()], timelineTransforms: null };
    const working = scenePostEffectParameterTrackToWorkingTime(track, authority);

    expect(working.keyframes.map(({ time }) => time)).toEqual([0.5, 2.5]);
    expect(scenePostEffectParameterKeyframesToSourceTime(working.keyframes, authority)).toEqual(track.keyframes);
  });

  it("rejects working markers inside inserted time for Rust and legacy mappings", () => {
    const keyframes = [{ easing: "smooth" as const, time: 1.5, value: 4 }];
    const boundaryKeyframes = [{ easing: "smooth" as const, time: 2, value: 4 }];
    const timelineTransforms = [
      {
        interval: { end: 2, start: 1 },
        kind: "insert" as const,
        operationId: "insert-wait",
      },
    ];

    expect(() =>
      scenePostEffectParameterKeyframesToSourceTime(keyframes, { programs: [], timelineTransforms }),
    ).toThrow(/inside inserted timeline time cannot be saved without moving/u);
    expect(() =>
      scenePostEffectParameterKeyframesToSourceTime(keyframes, {
        programs: [legacyInsertionProgram()],
        timelineTransforms: null,
      }),
    ).toThrow(/inside inserted timeline time cannot be saved without moving/u);
    expect(
      scenePostEffectParameterKeyframesToSourceTime(boundaryKeyframes, { programs: [], timelineTransforms }),
    ).toEqual([{ easing: "smooth", time: 1, value: 4 }]);
    expect(
      scenePostEffectParameterKeyframesToSourceTime(boundaryKeyframes, {
        programs: [legacyInsertionProgram()],
        timelineTransforms: null,
      }),
    ).toEqual([{ easing: "smooth", time: 1, value: 4 }]);
  });
});
