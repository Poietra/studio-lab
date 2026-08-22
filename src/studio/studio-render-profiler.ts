import type { ProfilerOnRenderCallback } from "react";

export type StudioRenderBoundary = "app" | "canvas" | "timeline" | "toolbar";

export type StudioRenderProfileEvent =
  | Readonly<{
      at: number;
      boundary: StudioRenderBoundary;
      kind: "render";
    }>
  | Readonly<{
      actualDuration: number;
      at: number;
      baseDuration: number;
      boundary: StudioRenderBoundary;
      kind: "commit";
      phase: "mount" | "nested-update" | "update";
    }>;

type StudioRenderProbeGlobal = typeof globalThis & {
  __POIETRA_STUDIO_RENDER_PROBE__?: (event: StudioRenderProfileEvent) => void;
};

function probe() {
  const candidate = (globalThis as StudioRenderProbeGlobal).__POIETRA_STUDIO_RENDER_PROBE__;
  return typeof candidate === "function" ? candidate : null;
}

function now() {
  return globalThis.performance?.now() ?? Date.now();
}

/** Test-only observation seam. It is a no-op unless a browser fixture installs a probe before Studio loads. */
export function markStudioRenderBoundary(boundary: StudioRenderBoundary) {
  probe()?.({ at: now(), boundary, kind: "render" });
}

export const recordStudioCommitProfile: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  _startTime,
  commitTime,
) => {
  if (id !== "canvas" && id !== "timeline" && id !== "toolbar") return;
  probe()?.({
    actualDuration,
    at: commitTime,
    baseDuration,
    boundary: id,
    kind: "commit",
    phase,
  });
};
