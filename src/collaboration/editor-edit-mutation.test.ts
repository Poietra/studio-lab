import { describe, expect, it } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import {
  applyEditorEditMutationV1,
  MAX_APPLIED_EDITOR_PROGRAMS_V1,
  parseAuthoritativeEditorProgramsV1,
  parseEditorEditMutationV1,
} from "./editor-edit-mutation";

function program(transactionId: string, anchor: number, deltaX = 1): CanonicalEditProgram {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: deltaX, y: 0 },
    dependsOn: [],
    easing: "smooth" as const,
    id: `${transactionId}/motion`,
    interval: { end: anchor + 1, start: anchor },
    kind: "CreateMotion" as const,
    provenance: { evidence: [], origin: "direct-manipulation" as const },
    targetEntityIds: ["equation"],
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [],
      resolvedSeconds: anchor,
      source: { kind: "absolute", seconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

describe("editor edit mutation contract", () => {
  it("strictly parses the three closed mutation variants", () => {
    const value = program("motion", 1);
    expect(parseEditorEditMutationV1({ kind: "append", program: value })).toEqual({
      kind: "append",
      program: value,
    });
    expect(parseEditorEditMutationV1({ kind: "replace", program: value, targetTransactionId: "motion" })).toEqual({
      kind: "replace",
      program: value,
      targetTransactionId: "motion",
    });
    expect(() => parseEditorEditMutationV1({ kind: "remove", program: value })).toThrow();
    expect(() => parseEditorEditMutationV1({ extra: true, kind: "append", program: value })).toThrow();
    expect(() => parseEditorEditMutationV1({ kind: "append", program: { ...value, unexpected: true } })).toThrow();
  });
});

describe("editor edit mutation fold", () => {
  it("strictly parses a bounded authoritative projection", () => {
    const first = program("first", 1);
    expect(parseAuthoritativeEditorProgramsV1([first])).toEqual([first]);
    expect(() => parseAuthoritativeEditorProgramsV1({ programs: [first] })).toThrow(/must be an array/i);
  });

  it("appends only a new transaction in source order and within the render bound", () => {
    const first = program("first", 1);
    const second = program("second", 2);
    expect(applyEditorEditMutationV1([first], { kind: "append", program: second })).toEqual({
      kind: "applied",
      programs: [first, second],
    });
    expect(applyEditorEditMutationV1([first], { kind: "append", program: program("first", 2) })).toEqual({
      kind: "conflict",
      reason: "transaction-exists",
    });
    expect(applyEditorEditMutationV1([first], { kind: "append", program: program("earlier", 0) })).toEqual({
      kind: "conflict",
      reason: "source-order-conflict",
    });
    expect(
      applyEditorEditMutationV1([first], {
        kind: "append",
        program: program("rounding-tolerance", 1 - 0.0004),
      }),
    ).toMatchObject({ kind: "applied" });
    expect(
      applyEditorEditMutationV1([program("binary64-boundary", 4.263952566698239)], {
        kind: "append",
        program: program("binary64-before-boundary", 4.263452566698239),
      }),
    ).toEqual({ kind: "conflict", reason: "source-order-conflict" });

    const full = Array.from({ length: MAX_APPLIED_EDITOR_PROGRAMS_V1 }, (_, index) =>
      program(`transaction-${index}`, index),
    );
    expect(
      applyEditorEditMutationV1(full, {
        kind: "append",
        program: program("one-too-many", MAX_APPLIED_EDITOR_PROGRAMS_V1),
      }),
    ).toEqual({ kind: "conflict", reason: "program-limit" });
  });

  it("replaces exactly one matching transaction without crossing its neighbors", () => {
    const programs = [program("first", 1), program("target", 2), program("last", 3)];
    const replacement = program("target", 2.5, 20);
    expect(
      applyEditorEditMutationV1(programs, {
        kind: "replace",
        program: replacement,
        targetTransactionId: "target",
      }),
    ).toEqual({ kind: "applied", programs: [programs[0], replacement, programs[2]] });
    expect(
      applyEditorEditMutationV1(programs, {
        kind: "replace",
        program: program("missing", 2),
        targetTransactionId: "missing",
      }),
    ).toEqual({ kind: "conflict", reason: "target-not-found" });
    expect(
      applyEditorEditMutationV1(programs, {
        kind: "replace",
        program: program("different", 2),
        targetTransactionId: "target",
      }),
    ).toEqual({ kind: "conflict", reason: "transaction-id-mismatch" });
    expect(
      applyEditorEditMutationV1(programs, {
        kind: "replace",
        program: program("target", 4),
        targetTransactionId: "target",
      }),
    ).toEqual({ kind: "conflict", reason: "source-order-conflict" });
  });

  it("removes only when the supplied Program is exact canonical evidence", () => {
    const first = program("first", 1);
    const target = program("target", 2);
    const last = program("last", 3);
    expect(
      applyEditorEditMutationV1([first, target, last], {
        kind: "remove",
        program: { ...target },
        targetTransactionId: "target",
      }),
    ).toEqual({ kind: "applied", programs: [first, last] });
    expect(
      applyEditorEditMutationV1([first, target, last], {
        kind: "remove",
        program: program("target", 2, 99),
        targetTransactionId: "target",
      }),
    ).toEqual({ kind: "conflict", reason: "evidence-mismatch" });
  });

  it("throws for corrupt authoritative input rather than disguising it as a concurrent conflict", () => {
    const duplicate = program("duplicate", 1);
    expect(() =>
      applyEditorEditMutationV1([duplicate, duplicate], {
        kind: "append",
        program: program("next", 2),
      }),
    ).toThrow(/duplicate transaction identity/i);
    expect(() =>
      applyEditorEditMutationV1([program("later", 2), program("earlier", 1)], {
        kind: "append",
        program: program("next", 3),
      }),
    ).toThrow(/canonical source order/i);
  });
});
