import { describe, expect, it } from "vitest";

import {
  mutationMayBeAborted,
  mutationTargetIsCurrent,
  type RenderMutationTarget,
  type RenderPipelineMutationContext,
} from "./render-mutation-policy";

function context(overrides: Partial<RenderPipelineMutationContext> = {}): RenderPipelineMutationContext {
  return {
    candidateKey: "candidate-a",
    policy: {
      commitBlocker: null,
      exportBlocker: null,
      previewBlocker: null,
      sessionMatchesCandidate: true,
    },
    sessionCanCommit: true,
    sessionId: "session-a",
    sourceExportKey: "source-a",
    ...overrides,
  };
}

describe("render mutation lifecycle policy", () => {
  it.each([
    ["exact Commit", { action: "commit", candidateKey: "candidate-a", sessionId: "session-a" }, {}, true],
    ["stale Commit candidate", { action: "commit", candidateKey: "candidate-b", sessionId: "session-a" }, {}, false],
    [
      "blocked Commit",
      { action: "commit", candidateKey: "candidate-a", sessionId: "session-a" },
      { policy: { ...context().policy, commitBlocker: "blocked" } },
      false,
    ],
    [
      "disabled Commit",
      { action: "commit", candidateKey: "candidate-a", sessionId: "session-a" },
      { sessionCanCommit: false },
      false,
    ],
    ["candidate Export", { action: "export-candidate", candidateKey: "candidate-a" }, {}, true],
    ["stale candidate Export", { action: "export-candidate", candidateKey: "candidate-b" }, {}, false],
    ["source Export", { action: "export-source", sourceExportKey: "source-a" }, {}, true],
    ["stale source Export", { action: "export-source", sourceExportKey: "source-b" }, {}, false],
    ["current Render", { action: "render", candidateKey: "candidate-a" }, {}, true],
    ["stale Render", { action: "render", candidateKey: "candidate-b" }, {}, false],
    ["current recovery action", { action: "discard", sessionId: "session-a" }, {}, true],
    ["stale recovery action", { action: "discard", sessionId: "session-b" }, {}, false],
  ] satisfies readonly [string, RenderMutationTarget, Partial<RenderPipelineMutationContext>, boolean][])(
    "%s",
    (_name, target, overrides, expected) => {
      expect(mutationTargetIsCurrent(target, context(overrides))).toBe(expected);
    },
  );

  it.each([
    ["commit", true],
    ["export-candidate", true],
    ["export-source", true],
    ["undo", true],
    ["render", false],
    ["cancel", false],
    ["discard", false],
  ] as const)("classifies whether %s may be aborted after context changes", (action, expected) => {
    const target =
      action === "commit"
        ? ({ action, candidateKey: "candidate-a", sessionId: "session-a" } as const)
        : action === "export-candidate" || action === "render"
          ? ({ action, candidateKey: "candidate-a" } as const)
          : action === "export-source"
            ? ({ action, sourceExportKey: "source-a" } as const)
            : ({ action, sessionId: "session-a" } as const);
    expect(mutationMayBeAborted(target)).toBe(expected);
  });
});
