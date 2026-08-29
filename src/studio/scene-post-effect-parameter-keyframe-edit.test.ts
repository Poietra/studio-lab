import { describe, expect, it } from "vitest";

import { createStudioScenePostEffectProgram } from "./authoring-commands";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE, validateMotionProgramFixture } from "./fixture";
import {
  insertScenePostEffectParameterKeyframe,
  removeScenePostEffectParameterKeyframe,
  replaceScenePostEffectParameterKeyframe,
  replaceScenePostEffectParameterKeyframeProgram,
  scenePostEffectParameterKeyframesToSourceTime,
  scenePostEffectParameterTrackMatchesEffects,
  scenePostEffectParameterTrackToWorkingTime,
} from "./scene-post-effect-parameter-keyframe-edit";

const effect = { parameters: [4, 2, 1, 0], revision: 1, shaderId: "rgb-split" } as const;

function owner() {
  const validation = createStudioScenePostEffectProgram({
    capturedPlayhead: 0,
    effects: [effect],
    scene: STUDIO_FIXTURE_SCENE,
    transactionId: "scene-effect-track",
  });
  return programRecord(validation.program, validation);
}

function parameterTrack(program: ReturnType<typeof owner>["program"]) {
  const operation = program.operations[0];
  return operation?.kind === "SetScenePostEffect" ? operation.parameterTrack : null;
}

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
