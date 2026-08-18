import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import {
  type CanvasFrameEvidenceResponseV1,
  CanvasWorkerClientError,
  type InstallCanvasSceneInputV1,
  type PresentedCanvasFrameV1,
  type RenderCanvasFrameInputV1,
  type ReplaceCanvasSceneInputV1,
} from "./canvas-worker-client";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";
import { type PreviewRendererHostStateV1, type PreviewRendererV1, StudioPreviewRendererHost } from "./preview-renderer";

const REVISION = "a".repeat(64);
const OTHER_REVISION = "b".repeat(64);
const THIRD_REVISION = "c".repeat(64);
const VIEWPORT = { heightPx: 90, widthPx: 160 } as const;
const OTHER_VIEWPORT = { heightPx: 180, widthPx: 320 } as const;
const CANVAS = {} as HTMLCanvasElement;
const ASSET_PAYLOAD = {
  assetId: "asset:image:0",
  byteLength: 4,
  bytes: new ArrayBuffer(4),
  mediaType: "image/png" as const,
  pixelHeight: 1,
  pixelWidth: 1,
  sha256: "d".repeat(64),
};

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
  const installs: InstallCanvasSceneInputV1[] = [];
  const replacements: { deferred: Deferred<void>; input: ReplaceCanvasSceneInputV1 }[] = [];
  const renders: { deferred: Deferred<PresentedCanvasFrameV1>; input: RenderCanvasFrameInputV1 }[] = [];
  const thumbnails: { deferred: Deferred<Uint8Array<ArrayBuffer>>; revision: string }[] = [];
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
    generateThumbnail: (revision) => {
      const pending = deferred<Uint8Array<ArrayBuffer>>();
      thumbnails.push({ deferred: pending, revision });
      return pending.promise;
    },
    installScene: (input) => {
      installs.push(input);
      return install.promise;
    },
    render: (input) => {
      const pending = deferred<PresentedCanvasFrameV1>();
      renders.push({ deferred: pending, input });
      return pending.promise;
    },
    replaceScene: (input) => {
      const pending = deferred<void>();
      replacements.push({ deferred: pending, input });
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
    installs,
    presentMismatchedRender: (
      index: number,
      mismatch: Partial<Pick<RenderCanvasFrameInputV1, "revision" | "sampleTime" | "viewport">>,
    ) => {
      const render = renders.at(index);
      if (!render) throw new Error(`No render request at index ${index}.`);
      render.deferred.resolve(frameFor({ ...render.input, ...mismatch }, index + 1));
    },
    presentRender: (index: number, overrides: Partial<PresentedCanvasFrameV1> = {}) => {
      const render = renders.at(index);
      if (!render) throw new Error(`No render request at index ${index}.`);
      render.deferred.resolve({ ...frameFor(render.input, index + 1), ...overrides });
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
    replacements,
    thumbnails,
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

function installInput(duration = 2, interactionEntityIds: readonly string[] = []) {
  return {
    canvas: CANVAS,
    ...(interactionEntityIds.length > 0 ? { interactionEntityIds } : {}),
    revision: REVISION,
    snapshot: { scene: { duration } } as unknown as SceneIrBundleV1,
  };
}

async function fixtureBundle() {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  return parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
}

async function updateInput(
  base: SceneIrBundleV1,
  revision: string,
  duration: number,
  interactionEntityIds: readonly string[],
) {
  const snapshot: SceneIrBundleV1 = {
    ...base,
    scene: {
      ...base.scene,
      duration,
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: revision },
    },
  };
  return {
    input: { interactionEntityIds, revision, snapshot },
    snapshot,
  };
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

async function readyUpdateFixture() {
  const fixture = createFixture();
  const snapshot = await fixtureBundle();
  const pending = fixture.host.install({ canvas: CANVAS, revision: REVISION, snapshot });
  fixture.install.resolve();
  await pending;
  return { fixture, snapshot };
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
  it("renders a thumbnail only for the revision captured by the caller", async () => {
    const { fixture, snapshot } = await readyUpdateFixture();
    await requestAndPresent(fixture, 0, 1);
    await expect(fixture.host.generateThumbnail(OTHER_REVISION)).rejects.toMatchObject({ code: "invalid-state" });
    expect(fixture.thumbnails).toHaveLength(0);

    const thumbnail = fixture.host.generateThumbnail(REVISION);
    expect(fixture.thumbnails[0]?.revision).toBe(REVISION);
    const update = await updateInput(snapshot, OTHER_REVISION, 3, []);
    const updating = fixture.host.update(update.input);
    fixture.thumbnails[0]?.deferred.resolve(new Uint8Array([1]));
    await expect(thumbnail).rejects.toMatchObject({ code: "stale-response" });
    fixture.replacements[0]?.deferred.resolve();
    await updating;
  });

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

  it("binds requested runtime IDs and prepared bounds to the exact presented frame", async () => {
    const fixture = createFixture();
    const interactionEntityIds = ["runtime#0"];
    const pending = fixture.host.install(installInput(2, interactionEntityIds));
    fixture.install.resolve();
    await pending;
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    expect(fixture.renders[0]?.input).toEqual({
      interactionEntityIds,
      revision: REVISION,
      sampleTime: 1,
      viewport: VIEWPORT,
    });
    fixture.presentRender(0, {
      interaction: {
        entries: [{ bounds: [-0.5, -0.25, 0.5, 0.25], status: "present" }],
        space: "clip-v1",
        status: "available",
      },
    });
    await flush();
    expect(fixture.host.state).toMatchObject({
      frame: {
        interaction: {
          entries: [{ bounds: [-0.5, -0.25, 0.5, 0.25], status: "present" }],
          status: "available",
        },
        sampleTime: 1,
      },
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

  it("forwards verified PNG payloads through install and full replacement", async () => {
    const fixture = createFixture();
    const pendingInstall = fixture.host.install({ ...installInput(), assetPayloads: [ASSET_PAYLOAD] });
    expect(fixture.installs[0]?.assetPayloads).toEqual([ASSET_PAYLOAD]);
    fixture.install.resolve();
    await pendingInstall;

    const snapshot = await fixtureBundle();
    // Seed the host with the structurally verified bundle expected by update.
    // The initial install fixture is deliberately minimal, so use a fresh host
    // for the replacement half of the transport assertion.
    const replacementFixture = createFixture();
    const installing = replacementFixture.host.install({ canvas: CANVAS, revision: REVISION, snapshot });
    replacementFixture.install.resolve();
    await installing;
    const revisionB = await updateInput(snapshot, OTHER_REVISION, snapshot.scene.duration, []);
    const replacing = replacementFixture.host.update({ ...revisionB.input, assetPayloads: [ASSET_PAYLOAD] });
    await vi.waitFor(() => expect(replacementFixture.replacements).toHaveLength(1));
    expect(replacementFixture.replacements[0]?.input.assetPayloads).toEqual([ASSET_PAYLOAD]);
    replacementFixture.replacements[0]?.deferred.resolve();
    await replacing;
  });

  it("serializes rapid A→B→C updates and presents only the final acknowledged revision", async () => {
    const { fixture, snapshot } = await readyUpdateFixture();
    await requestAndPresent(fixture, 0, 1);
    expect(fixture.host.state.phase).toBe("presented");

    const revisionB = await updateInput(snapshot, OTHER_REVISION, 3, ["runtime:b"]);
    const revisionC = await updateInput(revisionB.snapshot, THIRD_REVISION, 5, ["runtime:c"]);
    const updateB = fixture.host.update(revisionB.input);
    const updateC = fixture.host.update(revisionC.input);
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });
    await vi.waitFor(() => expect(fixture.replacements).toHaveLength(1));
    expect(fixture.replacements[0]?.input.baseRevision).toBe(REVISION);

    fixture.replacements[0]?.deferred.resolve();
    await vi.waitFor(() => expect(fixture.replacements).toHaveLength(2));
    expect(fixture.replacements[1]?.input.baseRevision).toBe(OTHER_REVISION);
    // The intermediate ACK advances the serialization base but can never
    // schedule or present a superseded B frame.
    expect(fixture.renders).toHaveLength(1);
    expect(fixture.host.state.phase).toBe("fallback");

    fixture.replacements[1]?.deferred.resolve();
    await Promise.all([updateB, updateC]);
    expect(fixture.renders).toHaveLength(2);
    expect(fixture.renders[1]?.input).toEqual({
      interactionEntityIds: ["runtime:c"],
      revision: THIRD_REVISION,
      sampleTime: 1,
      viewport: VIEWPORT,
    });
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "frame-stale" });

    await settlePresented(fixture, 1);
    expect(fixture.host.state).toEqual({
      frame: { packetId: "canvas:2", revision: THIRD_REVISION, sampleTime: 1, viewport: VIEWPORT },
      phase: "presented",
    });
    fixture.host.requestFrame({ sampleTime: 4, viewport: VIEWPORT });
    expect(fixture.renders[2]?.input.revision).toBe(THIRD_REVISION);
  });

  it("updates through one correlated full replacement", async () => {
    const { fixture, snapshot } = await readyUpdateFixture();
    fixture.host.requestFrame({ sampleTime: 1, viewport: VIEWPORT });
    const revisionB = await updateInput(snapshot, OTHER_REVISION, snapshot.scene.duration, []);
    const updating = fixture.host.update(revisionB.input);
    await vi.waitFor(() => expect(fixture.replacements).toHaveLength(1));
    expect(fixture.replacements[0]?.input).toMatchObject({
      baseRevision: REVISION,
      revision: OTHER_REVISION,
    });
    fixture.replacements[0]?.deferred.resolve();
    await updating;
    expect(fixture.renders[1]?.input.revision).toBe(OTHER_REVISION);
  });

  it("rejects a replacement snapshot whose revision is not correlated to the update", async () => {
    const { fixture, snapshot } = await readyUpdateFixture();
    const revisionB = await updateInput(snapshot, OTHER_REVISION, 3, []);
    const updating = fixture.host.update({
      ...revisionB.input,
      snapshot: {
        ...revisionB.snapshot,
        scene: {
          ...revisionB.snapshot.scene,
          source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: THIRD_REVISION },
        },
      },
    });
    await expect(updating).rejects.toMatchObject({ code: "invalid-input" });
    expect(fixture.replacements).toHaveLength(0);
    expect(fixture.disposeCount).toBe(1);
    expect(fixture.host.state).toMatchObject({ phase: "fallback", reason: "renderer-failed" });
  });

  it("treats an acknowledged update after disposal as inert lifecycle completion", async () => {
    const { fixture, snapshot } = await readyUpdateFixture();
    const revisionB = await updateInput(snapshot, OTHER_REVISION, 3, []);
    const updating = fixture.host.update(revisionB.input);
    await vi.waitFor(() => expect(fixture.replacements).toHaveLength(1));
    const emitted = fixture.states.length;
    fixture.host.dispose();
    fixture.replacements[0]?.deferred.resolve();
    await expect(updating).resolves.toBeUndefined();
    expect(fixture.states).toHaveLength(emitted);
    expect(fixture.disposeCount).toBe(1);
    expect(fixture.host.state).toEqual({ detail: null, phase: "fallback", reason: "disposed" });
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
