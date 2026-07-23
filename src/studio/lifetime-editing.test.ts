import { describe, expect, it } from "vitest";

import {
  createImportedEntityLifetimeProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  defaultEntityContent,
} from "./authoring-commands";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import { rebaseProgramTime } from "./program-composition";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";
import {
  buildLifetimeEditControls,
  findImportedLifetimeEdit,
  lifetimeControlKey,
  studioLifetimeOwnerReason,
} from "./lifetime-editing";

describe("lifetime editing controls", () => {
  it("keeps an imported start read-only while offering safe end trims", () => {
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: [],
      sourceDuration: 12,
      tracks: [{
        animatedChannels: [],
        entityId: "equation_1",
        label: "equation",
        lifetimes: [{ end: 12, start: 0 }],
        provisional: false,
        type: "MathTex",
      }],
    })[lifetimeControlKey("equation_1", 0)]!;

    expect(controls.startTargets).toEqual([]);
    expect(controls.moveTargets).toEqual([]);
    expect(controls.endTargets.map((target) => target.source.end)).toEqual([5, 7]);
    expect(controls.reason).toMatch(/original Python statement/i);
  });

  it("keeps an appended imported trim inside applied source order", () => {
    const wait = createSceneDurationProgram({
      capturedPlayhead: 7,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 13,
      transactionId: "later-source-program",
    });
    const record = programRecord(wait.program, wait);
    const track = projectProposedState(evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record],
    })), 5).timeline.objectTracks.find((candidate) => candidate.entityId === "equation_1")!;
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: [record],
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey("equation_1", 0)]!;

    expect(controls.endTargets.map((target) => target.source.end)).toEqual([7]);
    expect(controls.reason).toMatch(/applied source order/i);
  });

  it("does not misidentify a Delete Program as an editable imported lifetime trim", () => {
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 5,
      entityIds: ["equation_1"],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "delete-imported-equation",
    });
    const record = programRecord(removal.program, removal);
    const track = projectProposedState(evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record],
    })), 5).timeline.objectTracks.find((candidate) => candidate.entityId === "equation_1")!;
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: [record],
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey("equation_1", 0)]!;

    expect(controls.endTargets).toEqual([]);
    expect(controls.reason).toMatch(/Another applied Program controls/i);
  });

  it("offers restoration after an imported interval was shortened", () => {
    const trim = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "trim-equation-metadata",
    });
    const record = programRecord(trim.program, trim);
    const track = projectProposedState(evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record],
    })), 5).timeline.objectTracks.find((candidate) => candidate.entityId === "equation_1")!;
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: [record],
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey("equation_1", 0)]!;

    expect(findImportedLifetimeEdit([record], "equation_1", 0)?.index).toBe(0);
    expect(controls.endTargets.map((target) => target.source.end)).toEqual([5, 12]);
  });

  it("keeps restore available when it repairs an out-of-order imported trim", () => {
    const wait = createSceneDurationProgram({
      capturedPlayhead: 7,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 13,
      transactionId: "preceding-later-anchor",
    });
    const trim = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 5,
      targetEnd: 5,
      transactionId: "out-of-order-existing-trim",
    });
    const records = [programRecord(wait.program, wait), programRecord(trim.program, trim)];
    const track = projectProposedState(evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: records,
    })), 4).timeline.objectTracks.find((candidate) => candidate.entityId === "equation_1")!;
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: records,
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey("equation_1", 0)]!;

    expect(findImportedLifetimeEdit(records, "equation_1", 0)?.index).toBe(1);
    expect(controls.endTargets.map((target) => target.source.end)).toEqual([7, 12]);
  });

  it("offers both edge edits and width-preserving moves for a Studio-owned interval", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 3,
      entities: [{
        content: defaultEntityContent("Circle", ""),
        position: { x: 200, y: 120 },
        type: "Circle",
      }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "owned-lifetime-controls",
    });
    const create = insertion.validation.program.operations.find((operation) => operation.kind === "CreateEntity")!;
    const finiteProgram = {
      ...insertion.validation.program,
      operations: insertion.validation.program.operations.map((operation) => operation.kind === "CreateEntity"
        ? { ...operation, entity: { ...operation.entity, lifetime: { end: 5, start: 3 } } }
        : operation),
    };
    expect(create.entity.id).toBe(insertion.entityIds[0]);
    const record = programRecord(finiteProgram, { issues: [], kind: "valid" });
    const delayed = programRecord({
      ...rebaseProgramTime(finiteProgram, 2),
      anchor: finiteProgram.anchor,
    }, { issues: [], kind: "valid" });
    expect(studioLifetimeOwnerReason({ index: 0, record: delayed })).toMatch(/after its Program begins/i);
    const wait = createSceneDurationProgram({
      capturedPlayhead: 3,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 3,
      targetDuration: 13,
      transactionId: "same-anchor-wait",
    });
    const records = [record, programRecord(wait.program, wait)];
    const track = projectProposedState(evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: records,
    })), 4).timeline.objectTracks.find((candidate) => candidate.entityId === insertion.entityIds[0])!;
    const controls = buildLifetimeEditControls({
      anchors: [1, 3, 5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: records,
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey(insertion.entityIds[0]!, 0)]!;

    expect(controls.reason).toBeNull();
    expect(controls.startTargets.map((target) => target.source.start)).toEqual([1]);
    expect(controls.endTargets.map((target) => target.source.end)).toEqual([7, 12]);
    expect(controls.endTargets.find((target) => target.source.end === 7)?.working)
      .toEqual({ end: 8.4, start: 3 });
    expect(controls.moveTargets.map((target) => target.source)).toEqual([
      { end: 3, start: 1 },
    ]);
  });

  it("defers to a later Delete Program that owns a Studio-created lifetime end", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{
        content: defaultEntityContent("Circle", ""),
        position: { x: 200, y: 120 },
        type: "Circle",
      }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "owned-then-deleted",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const ownedScene = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [owner],
    })).evaluatedScene;
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 7,
      entityIds: [insertion.entityIds[0]!],
      scene: projectRuntimeSceneToSourceTimeline(ownedScene, [owner.program]),
      transactionId: "delete-owned-circle",
    });
    const records = [owner, programRecord(removal.program, removal)];
    const track = projectProposedState(evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: records,
    })), 6).timeline.objectTracks.find((candidate) => candidate.entityId === insertion.entityIds[0])!;
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: records,
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey(insertion.entityIds[0]!, 0)]!;

    expect(controls.startTargets).toEqual([]);
    expect(controls.endTargets).toEqual([]);
    expect(controls.moveTargets).toEqual([]);
    expect(controls.reason).toMatch(/Another applied Program controls/i);
  });

  it("builds controls independently for repeated imported lifetimes", () => {
    const repeatedScene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          equation_1: {
            ...STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1!,
            lifetime: [{ end: 2, start: 0 }, { end: 9, start: 5 }],
          },
        },
      },
    };
    const controls = buildLifetimeEditControls({
      anchors: [1, 2, 5, 7, 9],
      baseScene: repeatedScene,
      programs: [],
      sourceDuration: 12,
      tracks: [{
        animatedChannels: [],
        entityId: "equation_1",
        label: "equation",
        lifetimes: [{ end: 2, start: 0 }, { end: 9, start: 5 }],
        provisional: false,
        type: "MathTex",
      }],
    });

    expect(controls[lifetimeControlKey("equation_1", 0)]?.endTargets.map((target) => target.source.end))
      .toEqual([1]);
    expect(controls[lifetimeControlKey("equation_1", 1)]?.endTargets.map((target) => target.source.end))
      .toEqual([7]);

    const trim = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 9, start: 5 },
      scene: repeatedScene,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "trim-second-lifetime",
    });
    const trimmed = evaluateWorkingState({
      ...createFixtureWorkingState({ appliedPrograms: [programRecord(trim.program, trim)] }),
      runtimeSceneState: repeatedScene,
    });
    expect(trimmed.evaluatedScene.objectGraph.entities.equation_1?.lifetime)
      .toEqual([{ end: 2, start: 0 }, { end: 7, start: 5 }]);

    const restore = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 9, start: 5 },
      scene: repeatedScene,
      sourceAnchor: 7,
      targetEnd: 9,
      transactionId: trim.program.transactionId,
    });
    const restored = evaluateWorkingState({
      ...createFixtureWorkingState({ appliedPrograms: [programRecord(restore.program, restore)] }),
      runtimeSceneState: repeatedScene,
    });
    expect(restored.evaluatedScene.objectGraph.entities.equation_1?.lifetime)
      .toEqual([{ end: 2, start: 0 }, { end: 9, start: 5 }]);
  });
});
