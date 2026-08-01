import { describe, expect, it } from "vitest";

import { importManimScene } from "../render-pipeline/source-import";
import { materializeAuthoritativeEditorProgramsV1 } from "./editor-authority-state";
import type { EditorProgramRecord } from "./editor-session-store";
import type { CanonicalEditProgram } from "./operations";

const source = `from manim import *

class Demo(Scene):
    def construct(self):
        label = Text("Demo")
        self.add(label)
        self.wait(5)
`;

function scene() {
  const imported = importManimScene(source, "scene.py", "Demo");
  if (!imported) throw new Error("fixture import failed");
  return { ...imported, name: "Demo", nextSceneId: null, sourcePath: "scene.py" };
}

function program(label = "wait"): CanonicalEditProgram {
  return {
    anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: "shared/wait",
        interval: { end: 2, start: 1 },
        kind: "InsertTimelineEvent",
        label,
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: ["shared/wait"] },
    transactionId: "shared",
    version: 1,
  };
}

describe("authoritative Editor Program materialization", () => {
  it("preserves local authoring metadata only for an exact canonical match", () => {
    const exact = program();
    const local: EditorProgramRecord = {
      editorMetadata: { operation: null, selection: ["label"] },
      program: exact,
      validation: { issues: [], status: "valid" },
    };

    const preserved = materializeAuthoritativeEditorProgramsV1(scene(), [local], [exact]);
    const replaced = materializeAuthoritativeEditorProgramsV1(scene(), [local], [program("remote spelling")]);

    expect(preserved[0]?.editorMetadata).toEqual(local.editorMetadata);
    expect(replaced[0]?.editorMetadata).toBeUndefined();
    expect(replaced[0]?.validation.status).toBe("valid");
  });

  it("rejects a structurally valid remote Program that is invalid for the selected Scene", () => {
    expect(() =>
      materializeAuthoritativeEditorProgramsV1(scene(), [], [{ ...program(), loweringStatus: "unsupported" }]),
    ).toThrow(/invalid for the selected Scene/i);
  });
});
