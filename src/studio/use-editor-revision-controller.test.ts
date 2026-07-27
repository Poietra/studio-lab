import { describe, expect, it } from "vitest";

import { EditorRevisionRequestController } from "./use-editor-revision-controller";

describe("EditorRevisionRequestController", () => {
  it("aborts and rejects stale async work after a selection, revision, or mutation boundary", () => {
    const controller = new EditorRevisionRequestController();
    const first = controller.begin("project-a/source-a/revision-a");
    if (first === null) throw new Error("Expected the aligned revision to start work.");

    expect(controller.isCurrent(first, first.revisionKey)).toBe(true);
    expect(controller.isCurrent(first, "project-a/source-b/revision-a")).toBe(false);
    controller.synchronize("project-a/source-b/revision-a");
    expect(first.controller.signal.aborted).toBe(true);
    expect(controller.isCurrent(first, first.revisionKey)).toBe(false);

    const second = controller.begin("project-a/source-b/revision-b");
    if (second === null) throw new Error("Expected the replacement revision to start work.");
    controller.synchronize(null);
    expect(second.controller.signal.aborted).toBe(true);
    expect(controller.begin(null)).toBeNull();
  });

  it("lets only the latest request own pending completion for one canonical revision", () => {
    const controller = new EditorRevisionRequestController();
    const first = controller.begin("revision-a");
    const second = controller.begin("revision-a");
    if (first === null || second === null) throw new Error("Expected both requests to start.");
    expect(first.controller.signal.aborted).toBe(true);
    expect(controller.isCurrent(first, "revision-a")).toBe(false);
    expect(controller.isCurrent(second, "revision-a")).toBe(true);
    expect(controller.finish(first)).toBe(false);
    expect(controller.finish(second)).toBe(true);
    expect(controller.finish(first)).toBe(false);
    expect(controller.isCurrent(second, "revision-a")).toBe(false);
  });

  it("lets a cancelled owner clear pending state when no replacement request exists", () => {
    const controller = new EditorRevisionRequestController();
    const ticket = controller.begin("revision-a");
    if (ticket === null) throw new Error("Expected the request to start.");
    controller.synchronize(null);
    expect(ticket.controller.signal.aborted).toBe(true);
    expect(controller.finish(ticket)).toBe(true);
  });
});
