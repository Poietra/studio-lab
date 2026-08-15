import { describe, expect, it } from "vitest";

import {
  createImportedEntityLifetimeProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  defaultEntityContent,
} from "./authoring-commands";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, persistentRemoveProjectionFixture, STUDIO_FIXTURE_SCENE } from "./fixture";
import { buildLifetimeEditControls, findImportedLifetimeEdit, lifetimeControlKey } from "./lifetime-editing";
import { insertedProgramDuration } from "./program-composition";

describe("lifetime editing controls", () => {
  it("keeps an imported start read-only while offering safe end trims", () => {
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: [],
      sourceDuration: 12,
      tracks: [
        {
          animatedChannels: [],
          entityId: "equation_1",
          label: "equation",
          lifetimes: [{ end: 12, start: 0 }],
          provisional: false,
          type: "MathTex",
        },
      ],
    })[lifetimeControlKey("equation_1", 0)]!;

    expect(controls.startTargets).toEqual([]);
    expect(controls.moveTargets).toEqual([]);
    expect(controls.endTargets.map((target) => target.source.end)).toEqual([5, 7]);
    expect(controls.reason).toMatch(/original Python statement/i);
  });

  it("requires a Rust projection before building controls over timeline Programs", () => {
    const wait = createSceneDurationProgram({
      capturedPlayhead: 7,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 13,
      transactionId: "later-source-program",
    });
    const record = programRecord(wait.program, wait);
    const track = {
      animatedChannels: [],
      entityId: "equation_1",
      label: "equation",
      lifetimes: [{ end: 13, start: 0 }],
      provisional: false,
      type: "MathTex",
    } as const;
    expect(() =>
      buildLifetimeEditControls({
        anchors: [5, 7],
        baseScene: STUDIO_FIXTURE_SCENE,
        programs: [record],
        sourceDuration: 12,
        tracks: [track],
      }),
    ).toThrow(/Rust timeline projection/i);
  });

  it("does not misidentify a Delete Program as an editable imported lifetime trim", () => {
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 5,
      entityIds: ["equation_1"],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "delete-imported-equation",
    });
    const record = programRecord(removal.program, removal);
    const track = projectProposedState(
      evaluateWorkingState(
        createFixtureWorkingState({
          appliedPrograms: [record],
        }),
        persistentRemoveProjectionFixture(removal.program),
      ),
      5,
    ).timeline.objectTracks.find((candidate) => candidate.entityId === "equation_1")!;
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
    const track = projectProposedState(
      evaluateWorkingState(
        createFixtureWorkingState({
          appliedPrograms: [record],
        }),
        persistentRemoveProjectionFixture(trim.program),
      ),
      5,
    ).timeline.objectTracks.find((candidate) => candidate.entityId === "equation_1")!;
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

  it("offers edge edits and width-preserving moves for a Studio-owned interval", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 3,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 200, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "owned-lifetime-controls",
    });
    const finiteProgram = {
      ...insertion.validation.program,
      operations: insertion.validation.program.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? { ...operation, entity: { ...operation.entity, lifetime: { end: 5, start: 3 } } }
          : operation,
      ),
    };
    const record = programRecord(finiteProgram, { issues: [], kind: "valid" });
    const track = {
      animatedChannels: [],
      entityId: insertion.entityIds[0]!,
      label: "Circle",
      lifetimes: [{ end: 5.4, start: 3 }],
      provisional: false,
      type: "Circle",
    };
    const controls = buildLifetimeEditControls({
      anchors: [1, 3, 5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: [record],
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey(insertion.entityIds[0]!, 0)]!;

    expect(controls.reason).toBeNull();
    expect(controls.startTargets.map((target) => target.source.start)).toEqual([1]);
    expect(controls.endTargets.map((target) => target.source.end)).toEqual([7, 12]);
    expect(controls.endTargets.find((target) => target.source.end === 7)?.working).toEqual({ end: 7.4, start: 3 });
    expect(controls.moveTargets.map((target) => target.source)).toEqual([
      { end: 3, start: 1 },
      { end: 7, start: 5 },
    ]);
  });

  it("defers to a later Delete Program that owns a Studio-created lifetime end", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 200, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "owned-then-deleted",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const entityId = insertion.entityIds[0]!;
    const ownedScene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          [entityId]: {
            ...STUDIO_FIXTURE_SCENE.objectGraph.entities.proof_box!,
            id: entityId,
            lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 5 }],
            sourceIdentity: { kind: "unknown" as const, reason: "Studio-owned test entity." },
            transactionId: owner.program.transactionId,
            type: "Circle",
          },
        },
      },
    };
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 7,
      entityIds: [entityId],
      scene: ownedScene,
      transactionId: "delete-owned-circle",
    });
    const records = [owner, programRecord(removal.program, removal)];
    const track = {
      animatedChannels: [],
      entityId,
      label: "Circle",
      lifetimes: [{ end: 7.4 + insertedProgramDuration(owner.program), start: 5 }],
      provisional: false,
      type: "Circle",
    };
    const controls = buildLifetimeEditControls({
      anchors: [5, 7],
      baseScene: STUDIO_FIXTURE_SCENE,
      programs: records,
      sourceDuration: 12,
      tracks: [track],
    })[lifetimeControlKey(entityId, 0)]!;

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
            lifetime: [
              { end: 2, start: 0 },
              { end: 9, start: 5 },
              { end: 11, start: 10 },
            ],
          },
        },
      },
    };
    const controls = buildLifetimeEditControls({
      anchors: [1, 2, 5, 7, 9],
      baseScene: repeatedScene,
      programs: [],
      sourceDuration: 12,
      tracks: [
        {
          animatedChannels: [],
          entityId: "equation_1",
          label: "equation",
          lifetimes: [
            { end: 2, start: 0 },
            { end: 9, start: 5 },
            { end: 11, start: 10 },
          ],
          provisional: false,
          type: "MathTex",
        },
      ],
    });

    expect(controls[lifetimeControlKey("equation_1", 0)]?.endTargets.map((target) => target.source.end)).toEqual([1]);
    expect(controls[lifetimeControlKey("equation_1", 1)]?.endTargets.map((target) => target.source.end)).toEqual([7]);

    const trim = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 9, start: 5 },
      scene: repeatedScene,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "trim-second-lifetime",
    });
    const trimmed = evaluateWorkingState(
      {
        ...createFixtureWorkingState({ appliedPrograms: [programRecord(trim.program, trim)] }),
        runtimeSceneState: repeatedScene,
      },
      persistentRemoveProjectionFixture(trim.program),
    );
    expect(trimmed.evaluatedScene.objectGraph.entities.equation_1?.lifetime).toEqual([
      { end: 2, start: 0 },
      { end: 7, start: 5 },
    ]);
  });
});
