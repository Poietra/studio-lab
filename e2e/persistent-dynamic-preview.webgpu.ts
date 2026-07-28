import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

import type { CanvasFrameEvidenceResponseV1 } from "../src/engine/canvas-worker-client";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
import type { PreviewRendererHostStateV1, PreviewViewportV1 } from "../src/engine/preview-renderer";
import { createSceneIrDeltaV1, type SceneIrDeltaV1 } from "../src/engine/scene-delta";

const DELTA_REVISION = "b".repeat(64);
const RESTORED_REVISION = "c".repeat(64);
const WORKSPACE_REVISION = "d".repeat(64);
const INTERACTION_ENTITY_IDS = ["dynamic-parent", "asymmetric-child", "trim-motion-child"] as const;

type Viewport = PreviewViewportV1;
type RgbaPixel = readonly [number, number, number, number];
type FrameEvidence = CanvasFrameEvidenceResponseV1;
type PresentedState = Extract<PreviewRendererHostStateV1, Readonly<{ phase: "presented" }>>;
type HarnessSnapshot = Readonly<{
  deltaOperations: readonly string[];
  fullReplacements: number;
  oldEmissionCount: number | null;
  oldEmissionCountAtDispose: number | null;
  state: PreviewRendererHostStateV1;
  workerCount: number;
  workerTerminations: number;
  workspacePresentedRevisions: readonly string[];
}>;
type DynamicFixture = Readonly<{
  assets: SceneIrBundleV1["assets"];
  pixelReferences: Readonly<
    Record<
      string,
      Readonly<{
        samples: Readonly<
          Record<string, Readonly<{ at: readonly [number, number]; rgba: RgbaPixel; tolerance: number }>>
        >;
      }>
    >
  >;
  samples: readonly Readonly<{
    expected: Readonly<{
      drawEntityIds: readonly string[];
      pixelReferenceId: string;
      preparedClipBounds: Readonly<Record<string, readonly [number, number, number, number] | null>>;
    }>;
    id: string;
    sampleTime: number;
    viewport: Viewport;
  }>[];
  scene: SceneIrBundleV1["scene"];
}>;

type HarnessInput = Readonly<{
  base: SceneIrBundleV1;
  changed: SceneIrBundleV1;
  delta: SceneIrDeltaV1;
  restored: SceneIrBundleV1;
  workspace: SceneIrBundleV1;
}>;

function revisionBundle(bundle: SceneIrBundleV1, revision: string, includeAnimatedCamera = true) {
  if (bundle.scene.source.kind !== "studio-edit-program") throw new Error("The fixture must be Studio-owned.");
  return sceneIrBundleV1Schema.parse({
    assets: bundle.assets,
    scene: {
      ...bundle.scene,
      animationChannels: includeAnimatedCamera
        ? bundle.scene.animationChannels
        : bundle.scene.animationChannels.filter(({ id }) => id !== "camera:dynamic"),
      requiredCapabilities: includeAnimatedCamera
        ? bundle.scene.requiredCapabilities
        : bundle.scene.requiredCapabilities.filter((capability) => capability !== "camera-animation"),
      source: { ...bundle.scene.source, revisionHash: revision },
    },
  });
}

async function fixtureInput() {
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/dynamic-affine-camera.json", "utf8")) as DynamicFixture;
  const base = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
  const changed = revisionBundle(base, DELTA_REVISION, false);
  const delta = await createSceneIrDeltaV1(base, changed);
  if (!delta) throw new Error("The dynamic camera removal must fit the bounded Scene delta contract.");
  return {
    fixture,
    input: {
      base,
      changed,
      delta,
      restored: revisionBundle(base, RESTORED_REVISION),
      workspace: revisionBundle(base, WORKSPACE_REVISION),
    } satisfies HarnessInput,
  };
}

async function installHarness(page: Page, input: HarnessInput) {
  await page.goto("/");
  await page.evaluate(
    async ({ base, changed, delta, restored, workspace, interactionEntityIds, revisions }) => {
      const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
      const previewModuleUrl = "/src/engine/preview-renderer.ts";
      const { PoietraCanvasWorkerClient } = (await import(
        clientModuleUrl
      )) as typeof import("../src/engine/canvas-worker-client");
      const { StudioPreviewRendererHost } = (await import(
        previewModuleUrl
      )) as typeof import("../src/engine/preview-renderer");
      const evidenceModuleUrl = "/src/engine/canvas-worker-evidence.ts";
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        evidenceModuleUrl
      )) as typeof import("../src/engine/canvas-worker-evidence");

      document.body.replaceChildren();
      let workerCount = 0;
      let workerTerminations = 0;
      const deltaOperations: string[] = [];
      let fullReplacements = 0;
      let stateLog = { emissions: 0, presentedRevisions: [] as string[] };
      let oldStateLog: typeof stateLog | null = null;
      let oldEmissionCountAtDispose: number | null = null;
      let canvas: HTMLCanvasElement;

      const NativeWorker = globalThis.Worker;
      class CountingWorker extends NativeWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options);
          workerCount += 1;
        }

        override terminate() {
          workerTerminations += 1;
          super.terminate();
        }
      }
      globalThis.Worker = CountingWorker;

      const makeCanvas = () => {
        const next = document.createElement("canvas");
        next.height = 90;
        next.width = 160;
        document.body.replaceChildren(next);
        return next;
      };
      const makeRenderer = () => {
        const client = new PoietraCanvasWorkerClient({
          evidence: createCanvasWorkerClientEvidenceAdapterV1(),
          requestTimeoutMs: 30_000,
        });
        return {
          captureFrameEvidence: (value: Parameters<typeof client.captureFrameEvidence>[0]) =>
            client.captureFrameEvidence(value),
          dispose: () => client.dispose(),
          installScene: (value: Parameters<typeof client.installScene>[0]) => client.installScene(value),
          render: (value: Parameters<typeof client.render>[0]) => client.render(value),
          replaceScene: async (value: Parameters<typeof client.replaceScene>[0]) => {
            await client.replaceScene(value);
            fullReplacements += 1;
          },
          updateScene: async (value: Parameters<typeof client.updateScene>[0]) => {
            const result = await client.updateScene(value);
            deltaOperations.push(result.operation);
            return result;
          },
        };
      };
      const makeHost = () => {
        const stateSink = stateLog;
        return new StudioPreviewRendererHost({
          createRenderer: makeRenderer,
          onStateChange: (state) => {
            stateSink.emissions += 1;
            if (state.phase === "presented") stateSink.presentedRevisions.push(state.frame.revision);
          },
        });
      };

      canvas = makeCanvas();
      let host = makeHost();
      await host.install({
        canvas,
        interactionEntityIds,
        revision: base.scene.source.kind === "studio-edit-program" ? base.scene.source.revisionHash : "",
        snapshot: base,
      });

      const request = (sampleTime: number, viewport: Viewport) => {
        host.requestFrame({ sampleTime, viewport });
      };
      const snapshot = (): HarnessSnapshot => ({
        deltaOperations: [...deltaOperations],
        fullReplacements,
        oldEmissionCount: oldStateLog?.emissions ?? null,
        oldEmissionCountAtDispose,
        state: structuredClone(host.state) as HarnessSnapshot["state"],
        workerCount,
        workerTerminations,
        workspacePresentedRevisions: [...stateLog.presentedRevisions],
      });

      const update = async (value: Parameters<typeof host.update>[0]) => {
        const updating = host.update(value);
        const immediate = snapshot();
        await updating;
        return immediate;
      };
      const harness = {
        applyDelta: () =>
          update({
            delta,
            interactionEntityIds,
            revision: revisions.delta,
            snapshot: changed,
          }),
        capture: (samples: readonly Readonly<{ fractionX: number; fractionY: number }>[]) =>
          host.captureEvidence(samples),
        dispose: () => host.dispose(),
        rapid: (samples: readonly Readonly<{ sampleTime: number; viewport: Viewport }>[]) => {
          for (const sample of samples) request(sample.sampleTime, sample.viewport);
          return snapshot();
        },
        replace: () =>
          update({
            delta: null,
            interactionEntityIds,
            revision: revisions.restored,
            snapshot: restored,
          }),
        request: (sampleTime: number, viewport: Viewport) => {
          request(sampleTime, viewport);
          return snapshot();
        },
        snapshot,
        switchWorkspace: async (sampleTime: number, viewport: Viewport) => {
          request(0.5, viewport);
          oldStateLog = stateLog;
          host.dispose();
          oldEmissionCountAtDispose = oldStateLog.emissions;

          stateLog = { emissions: 0, presentedRevisions: [] };
          canvas = makeCanvas();
          host = makeHost();
          await host.install({
            canvas,
            interactionEntityIds,
            revision: revisions.workspace,
            snapshot: workspace,
          });
          request(sampleTime, viewport);
          return snapshot();
        },
      };
      (
        globalThis as typeof globalThis & { __poietraPersistentDynamicHarness?: typeof harness }
      ).__poietraPersistentDynamicHarness = harness;
    },
    {
      ...input,
      interactionEntityIds: INTERACTION_ENTITY_IDS,
      revisions: { delta: DELTA_REVISION, restored: RESTORED_REVISION, workspace: WORKSPACE_REVISION },
    },
  );
}

async function invoke<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ method, args }) => {
      const harness = (
        globalThis as typeof globalThis & {
          __poietraPersistentDynamicHarness?: Record<string, (...values: unknown[]) => unknown>;
        }
      ).__poietraPersistentDynamicHarness;
      if (!harness) throw new Error("The persistent dynamic harness is not installed.");
      const operation = harness[method];
      if (!operation) throw new Error(`Unknown persistent dynamic harness operation ${method}.`);
      return operation(...args);
    },
    { args, method },
  ) as Promise<T>;
}

async function waitForPresented(page: Page, revision: string, sampleTime: number, viewport: Viewport) {
  await expect
    .poll(() => invoke<HarnessSnapshot>(page, "snapshot"), { timeout: 30_000 })
    .toMatchObject({
      state: { frame: { revision, sampleTime, viewport }, phase: "presented" },
    });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const snapshot = await invoke<HarnessSnapshot>(page, "snapshot");
  if (snapshot.state.phase !== "presented") throw new Error("The correlated frame was withdrawn after presentation.");
  return snapshot;
}

function expectInteraction(state: PresentedState, sample: DynamicFixture["samples"][number]) {
  const interaction = state.frame.interaction;
  expect(interaction?.status).toBe("available");
  if (!interaction || interaction.status !== "available") throw new Error("Interaction bounds are unavailable.");
  const entries = interaction.entries;
  expect(entries).toHaveLength(INTERACTION_ENTITY_IDS.length);
  INTERACTION_ENTITY_IDS.forEach((entityId, index) => {
    const entry = entries[index];
    const bounds = sample.expected.preparedClipBounds[entityId];
    if (!sample.expected.drawEntityIds.includes(entityId)) {
      expect(entry?.status).toBe("inactive");
    } else if (bounds === null || bounds === undefined) {
      expect(entry?.status).toBe("empty");
    } else {
      expect(entry?.status).toBe("present");
      if (entry?.status !== "present") throw new Error(`Expected prepared bounds for ${entityId}.`);
      entry.bounds.forEach((value, component) => expect(value).toBeCloseTo(bounds[component]!, 6));
    }
  });
}

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance: number) {
  actual.forEach((component, index) => expect(Math.abs(component - expected[index]!)).toBeLessThanOrEqual(tolerance));
}

async function capturePixelEvidence(
  page: Page,
  fixture: DynamicFixture,
  sample: DynamicFixture["samples"][number],
  state: PresentedState,
) {
  const reference = fixture.pixelReferences[sample.expected.pixelReferenceId];
  if (!reference) throw new Error(`Pixel reference ${sample.expected.pixelReferenceId} is missing.`);
  const expectedSamples = Object.values(reference.samples);
  const evidence = await invoke<FrameEvidence>(
    page,
    "capture",
    expectedSamples.map(({ at: [x, y] }) => ({
      fractionX: x / sample.viewport.widthPx,
      fractionY: y / sample.viewport.heightPx,
    })),
  );
  expect(evidence).toMatchObject({
    packetId: state.frame.packetId,
    revision: state.frame.revision,
    sampleTime: sample.sampleTime,
    viewport: sample.viewport,
  });
  expect(evidence.surfaceFormat).toMatch(/^(bgra|rgba)8unorm$/);
  expectedSamples.forEach((expected, index) => {
    expectPixelNear(evidence.samples[index] ?? [0, 0, 0, 0], expected.rgba, expected.tolerance);
  });
  return evidence.samples;
}

test("keeps dynamic bounds correlated across one retained production session, revisions, and workspace switch", async ({
  page,
}) => {
  const { fixture, input } = await fixtureInput();
  expect(fixture.samples.map(({ sampleTime }) => sampleTime)).toEqual([0.75, 0, 0.5, 0.25, 0.75, 60, 0.75]);
  await installHarness(page, input);
  const baseRevision =
    input.base.scene.source.kind === "studio-edit-program" ? input.base.scene.source.revisionHash : "";
  const packets = new Set<string>();
  const pixelSamples = new Map<string, readonly RgbaPixel[]>();
  let baseInteraction: PresentedState["frame"]["interaction"] | undefined;

  for (const sample of fixture.samples) {
    await invoke(page, "request", sample.sampleTime, sample.viewport);
    const snapshot = await waitForPresented(page, baseRevision, sample.sampleTime, sample.viewport);
    if (snapshot.state.phase !== "presented") throw new Error("Expected a presented dynamic sample.");
    expectInteraction(snapshot.state, sample);
    expect(packets.has(snapshot.state.frame.packetId)).toBe(false);
    packets.add(snapshot.state.frame.packetId);
    const pixels = await capturePixelEvidence(page, fixture, sample, snapshot.state);
    const prior = pixelSamples.get(sample.expected.pixelReferenceId);
    if (prior === undefined) pixelSamples.set(sample.expected.pixelReferenceId, pixels);
    else expect(pixels).toEqual(prior);
    if (sample.id === "a-first") baseInteraction = snapshot.state.frame.interaction;
  }
  expect(pixelSamples.get("a")).toBeDefined();
  expect(pixelSamples.get("b-start")).not.toEqual(pixelSamples.get("a"));
  expect((await invoke<HarnessSnapshot>(page, "snapshot")).workerCount).toBe(1);

  const aSample = fixture.samples.find(({ id }) => id === "a-first");
  if (!aSample) throw new Error("The shared A sample is missing.");
  const beforeRapid = await invoke<HarnessSnapshot>(page, "snapshot");
  if (beforeRapid.state.phase !== "presented") throw new Error("The retained session lost its prior frame.");
  const rapid = await invoke<HarnessSnapshot>(page, "rapid", [
    { sampleTime: 0.25, viewport: aSample.viewport },
    { sampleTime: 0.5, viewport: aSample.viewport },
    { sampleTime: aSample.sampleTime, viewport: aSample.viewport },
  ]);
  expect(rapid.state).toMatchObject({ phase: "fallback", reason: "frame-stale" });
  const rapidA = await waitForPresented(page, baseRevision, aSample.sampleTime, aSample.viewport);
  if (rapidA.state.phase !== "presented") throw new Error("The final rapid A frame was not presented.");
  expectInteraction(rapidA.state, aSample);
  expect(rapidA.state.frame.packetId).not.toBe(beforeRapid.state.frame.packetId);

  const deltaUpdate = await invoke<HarnessSnapshot>(page, "applyDelta");
  expect(deltaUpdate.state).toMatchObject({ phase: "fallback", reason: "frame-stale" });
  const changed = await waitForPresented(page, DELTA_REVISION, aSample.sampleTime, aSample.viewport);
  expect(changed.deltaOperations).toEqual(["delta"]);
  expect(changed.fullReplacements).toBe(0);
  expect(changed.workerCount).toBe(1);
  if (changed.state.phase !== "presented") throw new Error("The delta revision was not presented.");
  expect(changed.state.frame.interaction).not.toEqual(baseInteraction);

  const replacement = await invoke<HarnessSnapshot>(page, "replace");
  expect(replacement.state).toMatchObject({ phase: "fallback", reason: "frame-stale" });
  const restored = await waitForPresented(page, RESTORED_REVISION, aSample.sampleTime, aSample.viewport);
  expect(restored.deltaOperations).toEqual(["delta"]);
  expect(restored.fullReplacements).toBe(1);
  expect(restored.workerCount).toBe(1);
  if (restored.state.phase !== "presented") throw new Error("The replacement revision was not presented.");
  expectInteraction(restored.state, aSample);
  expect(restored.state.frame.interaction).toEqual(baseInteraction);
  expect(await capturePixelEvidence(page, fixture, aSample, restored.state)).toEqual(pixelSamples.get("a"));

  await invoke(page, "switchWorkspace", aSample.sampleTime, aSample.viewport);
  const switched = await waitForPresented(page, WORKSPACE_REVISION, aSample.sampleTime, aSample.viewport);
  expect(switched.workerCount).toBe(2);
  expect(switched.workerTerminations).toBe(1);
  expect(switched.oldEmissionCount).toBe(switched.oldEmissionCountAtDispose);
  expect(switched.workspacePresentedRevisions).toEqual([WORKSPACE_REVISION]);
  if (switched.state.phase !== "presented") throw new Error("The switched workspace was not presented.");
  expectInteraction(switched.state, aSample);
  expect(await capturePixelEvidence(page, fixture, aSample, switched.state)).toEqual(pixelSamples.get("a"));

  await invoke(page, "dispose");
  expect((await invoke<HarnessSnapshot>(page, "snapshot")).workerTerminations).toBe(2);
});
