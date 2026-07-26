import { describe, expect, it } from "vitest";
import {
  type CanvasFrameEvidenceResponseV1,
  CanvasWorkerClientError,
  type PresentedCanvasFrameV1,
  type RenderCanvasFrameInputV1,
} from "./canvas-worker-client";
import type { SceneIrBundleV1 } from "./contracts";
import { type PreviewRendererHostStateV1, type PreviewRendererV1, StudioPreviewRendererHost } from "./preview-renderer";

const REVISION = "a".repeat(64);
const OTHER_REVISION = "b".repeat(64);
const VIEWPORT = { heightPx: 90, widthPx: 160 } as const;
const OTHER_VIEWPORT = { heightPx: 180, widthPx: 320 } as const;
const CANVAS = {} as HTMLCanvasElement;

type Deferred<T> = Readonly<{ promise: Promise<T>; reject: (error: unknown) => void; resolve: (value: T) => void }>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function frameFor(input: RenderCanvasFrameInputV1, requestId: number): PresentedCanvasFrameV1 {
  return {
    kind: "frame-presented",
    packetId: `canvas:${requestId}`,
    requestId,
    revision: input.revision,
    sampleTime: input.sampleTime,
    schema: "poietra.canvas-worker-response",
    suboptimal: false,
    version: 1,
    viewport: { ...input.viewport },
  };
}

function createFixture() {
  const install = deferred<void>();
  const renders: { deferred: Deferred<PresentedCanvasFrameV1>; input: RenderCanvasFrameInputV1 }[] = [];
  let disposeCount = 0;
  let evidence: CanvasFrameEvidenceResponseV1 | null = null;
  let deferredEvidence: Deferred<CanvasFrameEvidenceResponseV1> | null = null;
  const renderer: PreviewRendererV1 = {
    captureFrameEvidence: () => {
      if (deferredEvidence) return deferredEvidence.promise;
      if (!evidence) {
        return Promise.reject(
          new CanvasWorkerClientError("invalid-state", "No evidence is configured on the fake renderer."),
        );
      }
      return Promise.resolve(evidence);
    },
    dispose: () => {
      disposeCount += 1;
    },
    installScene: () => install.promise,
    render: (input) => {
      const pending = deferred<PresentedCanvasFrameV1>();
      renders.push({ deferred: pending, input });
      return pending.promise;
    },
  };
  const states: PreviewRendererHostStateV1[] = [];
  const host = new StudioPreviewRendererHost({
    createRenderer: () => renderer,
    onStateChange: (state) => states.push(state),
  });
  return {
    get disposeCount() {
      return disposeCount;
    },
    host,
    install,
    presentMismatchedRender: (
      index: number,
      mismatch: Partial<Pick<RenderCanvasFrameInputV1, "revision" | "sampleTime" | "viewport">>,
    ) => {
      const render = renders.at(index);
      if (!render) throw new Error(`No render request at index ${index}.`);
      render.deferred.resolve(frameFor({ ...render.input, ...mismatch }, index + 1));
    },
    presentRender: (index: number) => {
      const render = renders.at(index);
      if (!render) throw new Error(`No render request at index ${index}.`);
      render.deferred.resolve(frameFor(render.input, index + 1));
    },
    rejectRender: (index: number, error: unknown) => {
      const render = renders.at(index);
      if (!render) throw new Error(`No render request at index ${index}.`);
      render.deferred.reject(error);
    },
    deferEvidence: () => {
      deferredEvidence = deferred<CanvasFrameEvidenceResponseV1>();
      return deferredEvidence;
    },
    renders,
    setEvidence: (value: CanvasFrameEvidenceResponseV1 | null) => {
      evidence = value;
    },
    states,
  };
}

const SAMPLE_POINTS = [{ fractionX: 0.5, fractionY: 0.5 }] as const;

function evidenceFor(
  frame: Readonly<{
    packetId: string;
    revision: string;
    sampleTime: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>,
): CanvasFrameEvidenceResponseV1 {
  return {
    kind: "frame-evidence",
    packetId: frame.packetId,
    requestId: 99,
    revision: frame.revision,
    sampleTime: frame.sampleTime,
    samples: [[1, 2, 3, 255] as [number, number, number, number]],
    schema: "poietra.canvas-worker-response",
    surfaceFormat: "rgba8unorm",
    version: 1,
    viewport: { ...frame.viewport },
  };
}

function installInput(duration = 2) {
  return { canvas: CANVAS, revision: REVISION, snapshot: { scene: { duration } } as unknown as SceneIrBundleV1 };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function readyFixture() {
  const fixture = createFixture();
  const pending = fixture.host.install(installInput());
  fixture.install.resolve();
  await pending;
  return fixture;
}

type Fixture = Awaited<ReturnType<typeof readyFixture>>;

async function settlePresented(fixture: Fixture, index: number) {
  fixture.presentRender(index);
  await flush();
}

async function requestAndPresent(
  fixture: Fixture,
  index: number,
  sampleTime: number,
  viewport = VIEWPORT as Readonly<{ heightPx: number; widthPx: number }>,
) {
  fixture.host.requestFrame({ sampleTime, viewport });
  await settlePresented(fixture, index);
}

describe("StudioPreviewRendererHost", () => {
  it("presents only after an exactly correlated frame arrives", async () => {
    const fixture = createFixture();
    const pending = fixture.host.install(installInput());
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "installing" });
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "installing" });
    fixture.install.resolve();
    await pending;
    expect(fixture.renders).toHaveLength(1);
    expect(fixture.renders[0]?.input).toEqual({ revision: REVISION, sampleTime: 1, viewport: VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-pending" });
    await settlePresented(fixture, 0);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:1", revision: REVISION, sampleTime: 1, viewport: VIEWPORT },
      phase: "presented",
    });
  });

  it("reports a stale frame while a newer sampleTime is pending", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 0.5);
    expect(fixture.host.state.phase).toBe("presented");
    fixture.host.requestFrame({ sampleTime: 1.5, viewport: VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });
    await settlePresented(fixture, 1);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:2", revision: REVISION, sampleTime: 1.5, viewport: VIEWPORT },
      phase: "presented",
    });
  });

  it("ignores a superseded completion that settles after the newest correct frame", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 0.25, viewport: VIEWPORT });
    fixture.host.requestFrame({ sampleTime: 0.75, viewport: VIEWPORT });
    await settlePresented(fixture, 1);
    expect(fixture.host.state.phase).toBe("presented");
    await settlePresented(fixture, 0);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:2", revision: REVISION, sampleTime: 0.75, viewport: VIEWPORT },
      phase: "presented",
    });
  });

  it.each([
    ["sampleTime", { sampleTime: 2 }],
    ["revision", { revision: OTHER_REVISION }],
    ["viewport", { viewport: OTHER_VIEWPORT }],
  ] as const)("fails whole-Scene when a presented frame mismatches its request on %s", async (_axis, mismatch) => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.presentMismatchedRender(0, mismatch);
    await flush();
    expect(fixture.host.state).toEqual({
      detail: "protocol-violation: the presented frame does not match its render request.",
      phase: "fallback",
      reason: "renderer-failed",
    });
    expect(fixture.disposeCount).toBe(1);
  });

  it("ignores a superseded render error without hiding the newest frame", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 0.25, viewport: VIEWPORT });
    fixture.host.requestFrame({ sampleTime: 0.75, viewport: VIEWPORT });
    await settlePresented(fixture, 1);
    fixture.rejectRender(0, new CanvasWorkerClientError("evaluation-failed", "Old sample failed."));
    await flush();
    expect(fixture.host.state.phase).toBe("presented");
  });

  it("maps unsupported-frame render errors to an explicit capability fallback", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.rejectRender(
      0,
      new CanvasWorkerClientError("unsupported-frame", "The frame needs an unsupported feature."),
    );
    await flush();
    expect(fixture.host.state).toEqual({
      detail: "unsupported-frame: The frame needs an unsupported feature.",
      phase: "fallback",
      reason: "capability-unsupported",
    });
  });

  it("treats a viewport change as stale until the resized frame is presented", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 1);
    fixture.host.requestFrame({ sampleTime: 1, viewport: OTHER_VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });
    await settlePresented(fixture, 1);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:2", revision: REVISION, sampleTime: 1, viewport: OTHER_VIEWPORT },
      phase: "presented",
    });
  });

  it("falls back with a reason for recoverable render errors and recovers on the next frame", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.rejectRender(0, new CanvasWorkerClientError("evaluation-failed", "The sample could not be evaluated."));
    await flush();
    expect(fixture.host.state).toEqual({
      detail: "evaluation-failed: The sample could not be evaluated.",
      phase: "fallback",
      reason: "render-error",
    });
    expect(fixture.disposeCount).toBe(0);
    await requestAndPresent(fixture, 1, 1.25);
    expect(fixture.host.state.phase).toBe("presented");
  });

  it("withdraws an old render error while the same target is retried", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.rejectRender(0, new CanvasWorkerClientError("evaluation-failed", "The first attempt failed."));
    await flush();
    expect(fixture.host.state).toMatchObject({ phase: "fallback", reason: "render-error" });

    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-pending" });
    await settlePresented(fixture, 1);
    expect(fixture.host.state.phase).toBe("presented");
  });

  it("falls back truthfully when a repeat render for the already presented target fails", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 1);
    expect(fixture.host.state.phase).toBe("presented");
    fixture.setEvidence(evidenceFor({ packetId: "canvas:1", revision: REVISION, sampleTime: 1, viewport: VIEWPORT }));
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.rejectRender(1, new CanvasWorkerClientError("evaluation-failed", "The repeat sample failed."));
    await flush();
    expect(fixture.host.state).toEqual({
      detail: "evaluation-failed: The repeat sample failed.",
      phase: "fallback",
      reason: "render-error",
    });
    expect(fixture.disposeCount).toBe(0);
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "invalid-state" });
    await requestAndPresent(fixture, 2, 1);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:3", revision: REVISION, sampleTime: 1, viewport: VIEWPORT },
      phase: "presented",
    });
  });

  it("fails whole-Scene and disposes the renderer on device loss", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.rejectRender(0, new CanvasWorkerClientError("device-lost", "The GPU device was lost."));
    await flush();
    expect(fixture.host.state).toEqual({
      detail: "device-lost: The GPU device was lost.",
      phase: "fallback",
      reason: "renderer-failed",
    });
    expect(fixture.disposeCount).toBe(1);
    fixture.host.requestFrame({ sampleTime: 1.5, viewport: VIEWPORT });
    expect(fixture.renders).toHaveLength(1);
    expect(fixture.host.state.phase).toBe("fallback");
  });

  it("treats every error the client itself does not survive as fatal, including stale-revision", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.rejectRender(0, new CanvasWorkerClientError("stale-revision", "The worker revision is stale."));
    await flush();
    expect(fixture.host.state).toEqual({
      detail: "stale-revision: The worker revision is stale.",
      phase: "fallback",
      reason: "renderer-failed",
    });
    expect(fixture.disposeCount).toBe(1);
  });

  it("reports install failures without throwing", async () => {
    const fixture = createFixture();
    const pending = fixture.host.install(installInput());
    fixture.install.reject(new CanvasWorkerClientError("wasm-load-failed", "The WASM module could not load."));
    await pending;
    expect(fixture.host.state).toEqual({
      detail: "wasm-load-failed: The WASM module could not load.",
      phase: "fallback",
      reason: "install-failed",
    });
    expect(fixture.disposeCount).toBe(1);
  });

  it("rejects a second snapshot install to keep the install-once contract", async () => {
    const fixture = createFixture();
    const pending = fixture.host.install(installInput());
    await expect(fixture.host.install(installInput())).rejects.toMatchObject({ code: "invalid-state" });
    fixture.install.resolve();
    await pending;
  });

  it("forces whole-Scene fallback during transient edits and restores afterwards", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 1);
    fixture.host.setTransientEdit(true);
    expect(fixture.host.state).toMatchObject({ phase: "fallback", reason: "transient-edit" });
    fixture.host.setTransientEdit(false);
    expect(fixture.host.state.phase).toBe("presented");
  });

  it("derives the playhead range from the installed snapshot so no caller can widen it", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 5, viewport: VIEWPORT });
    expect(fixture.renders).toHaveLength(0);
    expect(fixture.host.state).toMatchObject({ phase: "fallback", reason: "sample-out-of-range" });
    fixture.host.requestFrame({ sampleTime: 2, viewport: VIEWPORT });
    expect(fixture.renders).toHaveLength(1);
  });

  it("falls back when the Studio canvas has no measurable viewport", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: null });
    expect(fixture.renders).toHaveLength(0);
    expect(fixture.host.state).toMatchObject({ phase: "fallback", reason: "viewport-unavailable" });
  });

  it("emits nothing after dispose and disposes the renderer exactly once", async () => {
    const fixture = createFixture();
    const pending = fixture.host.install(installInput());
    fixture.host.dispose();
    const emitted = fixture.states.length;
    fixture.install.resolve();
    await pending;
    expect(fixture.states).toHaveLength(emitted);
    expect(fixture.disposeCount).toBe(1);
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    expect(fixture.renders).toHaveLength(0);
  });

  it("ignores superseded render rejections during rapid scrubbing", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 0.2, viewport: VIEWPORT });
    fixture.host.requestFrame({ sampleTime: 0.4, viewport: VIEWPORT });
    fixture.host.requestFrame({ sampleTime: 0.6, viewport: VIEWPORT });
    fixture.rejectRender(0, new CanvasWorkerClientError("stale-response", "Superseded."));
    fixture.rejectRender(1, new CanvasWorkerClientError("stale-response", "Superseded."));
    await flush();
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-pending" });
    await settlePresented(fixture, 2);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:3", revision: REVISION, sampleTime: 0.6, viewport: VIEWPORT },
      phase: "presented",
    });
  });

  it("serves evidence only while a frame is truthfully presented and it matches exactly", async () => {
    const fixture = await readyFixture();
    fixture.setEvidence(evidenceFor({ packetId: "canvas:1", revision: REVISION, sampleTime: 1, viewport: VIEWPORT }));
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "invalid-state" });
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "invalid-state" });
    await settlePresented(fixture, 0);
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).resolves.toMatchObject({
      packetId: "canvas:1",
      revision: REVISION,
      sampleTime: 1,
    });
  });

  it("rejects returned evidence that does not match the presented frame exactly", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 1);
    fixture.setEvidence(evidenceFor({ packetId: "canvas:9", revision: REVISION, sampleTime: 1, viewport: VIEWPORT }));
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "protocol-violation" });
    fixture.setEvidence(
      evidenceFor({ packetId: "canvas:1", revision: OTHER_REVISION, sampleTime: 1, viewport: VIEWPORT }),
    );
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "protocol-violation" });
    fixture.setEvidence(
      evidenceFor({ packetId: "canvas:1", revision: REVISION, sampleTime: 1, viewport: OTHER_VIEWPORT }),
    );
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "protocol-violation" });
  });

  it("never re-claims a presented frame across an A→B→A scrub until the fresh A render succeeds", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 1);
    expect(fixture.host.state.phase).toBe("presented");
    fixture.setEvidence(evidenceFor({ packetId: "canvas:1", revision: REVISION, sampleTime: 1, viewport: VIEWPORT }));

    fixture.host.requestFrame({ sampleTime: 2, viewport: VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });

    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).rejects.toMatchObject({ code: "invalid-state" });

    await settlePresented(fixture, 1);
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });

    await settlePresented(fixture, 2);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:3", revision: REVISION, sampleTime: 1, viewport: VIEWPORT },
      phase: "presented",
    });
    fixture.setEvidence(evidenceFor({ packetId: "canvas:3", revision: REVISION, sampleTime: 1, viewport: VIEWPORT }));
    await expect(fixture.host.captureEvidence(SAMPLE_POINTS)).resolves.toMatchObject({ packetId: "canvas:3" });
  });

  it("rejects deferred evidence that settles after the host was disposed", async () => {
    const fixture = await readyFixture();
    await requestAndPresent(fixture, 0, 1);
    expect(fixture.host.state.phase).toBe("presented");
    const deferredEvidence = fixture.deferEvidence();
    const capturing = fixture.host.captureEvidence(SAMPLE_POINTS);
    const emitted = fixture.states.length;
    fixture.host.dispose();
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "disposed" });
    expect(fixture.states).toHaveLength(emitted);
    expect(fixture.disposeCount).toBe(1);
    deferredEvidence.resolve(
      evidenceFor({ packetId: "canvas:1", revision: REVISION, sampleTime: 1, viewport: VIEWPORT }),
    );
    await expect(capturing).rejects.toMatchObject({ code: "invalid-state" });
    expect(fixture.states).toHaveLength(emitted);
    expect(fixture.disposeCount).toBe(1);
  });

  it("deduplicates identical state emissions", async () => {
    const fixture = await readyFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    fixture.presentRender(0);
    fixture.presentRender(1);
    await flush();
    const presented = fixture.states.filter((state) => state.phase === "presented");
    expect(presented).toHaveLength(1);
  });
});
