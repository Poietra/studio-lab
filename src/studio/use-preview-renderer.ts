import { useCallback, useEffect, useMemo, useState } from "react";
import type { CaptureCanvasFrameEvidenceInputV1 } from "../engine/canvas-worker-client";
import {
  createCanvasPreviewRendererV1,
  type PreviewRendererHostStateV1,
  type PreviewViewportV1,
  StudioPreviewRendererHost,
} from "../engine/preview-renderer";
import {
  detectStudioPreviewCapabilitiesV1,
  evaluateStudioPreviewEligibilityV1,
  projectStudioPreviewStaticInteractionGeometryV1,
  resolveStudioPreviewViewStateV1,
  snapStudioPreviewViewportV1,
  type StudioPreviewHostBindingV1,
  type StudioPreviewInteractionGeometryV1,
  studioPreviewHostBindingCurrentV1,
} from "./preview-renderer-policy";
import {
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotProviderV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";

export type StudioPreviewRendererViewV1 = Readonly<{
  attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  epoch: number;
  /**
   * Hit-target geometry projected from the verified snapshot, keyed by IR
   * entity ID; non-null only while a correlated frame is presented.
   */
  interactionGeometry: StudioPreviewInteractionGeometryV1 | null;
  sourceLabel: string | null;
  state: PreviewRendererHostStateV1;
}>;

export type UseStudioPreviewRendererInputV1 = Readonly<{
  context: StudioPreviewEditingContextV1 | null;
  frame: Readonly<{ height: number; width: number }>;
  provider: StudioPreviewSnapshotProviderV1 | null;
  sampleTime: number;
  transientEdit: boolean;
}>;

// transferControlToOffscreen is irreversible per element, so a canvas that
// already fed one worker can never be reused; the epoch key mints a fresh one.
const consumedCanvases = new WeakSet<object>();

/**
 * Returns true exactly once per canvas element. A second claim (StrictMode
 * double-mount, workspace switch onto a kept-alive element) must instead mint
 * a fresh canvas via the epoch key.
 */
export function claimStudioPreviewCanvasV1(canvas: object): boolean {
  if (consumedCanvases.has(canvas)) return false;
  consumedCanvases.add(canvas);
  return true;
}

type BoundHostStateV1 = Readonly<{
  binding: StudioPreviewHostBindingV1;
  host: StudioPreviewRendererHost;
  state: PreviewRendererHostStateV1;
}>;

const INSTALLING_STATE: PreviewRendererHostStateV1 = { detail: null, phase: "fallback", reason: "installing" };

export function useStudioPreviewRenderer(input: UseStudioPreviewRendererInputV1): StudioPreviewRendererViewV1 | null {
  const { context, frame, provider, sampleTime, transientEdit } = input;
  const [bound, setBound] = useState<BoundHostStateV1 | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [snapshot, setSnapshot] = useState<StudioVerifiedPreviewSnapshotV1 | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<PreviewViewportV1 | null>(null);

  const eligibility = useMemo(
    () =>
      evaluateStudioPreviewEligibilityV1({
        ...detectStudioPreviewCapabilitiesV1(),
        providerAvailable: provider !== null,
      }),
    [provider],
  );

  // The Scene identity that owns the installed worker; the working revision
  // gates presentation instead of tearing the retained worker down. A project
  // switch always changes the key, even onto a Scene with an identical source
  // hash and name.
  const workspaceKey = context ? studioPreviewWorkspaceKeyV1(context) : null;

  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => setCanvasEl(canvas), []);

  useEffect(() => {
    if (!provider || !eligibility.eligible || !context || workspaceKey === null) return;
    const controller = new AbortController();
    setSnapshot(null);
    setSnapshotError(null);
    provider
      .loadVerifiedSnapshot({
        identity: {
          projectId: context.projectId,
          sceneName: context.sceneName,
          sourceHash: context.sourceHash,
          sourcePath: context.sourcePath,
        },
        signal: controller.signal,
      })
      .then((loaded) => {
        if (!controller.signal.aborted) setSnapshot(loaded);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSnapshotError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
    // Keyed by Scene identity, not the full context: the working revision must
    // not re-trigger loads, only gate presentation.
  }, [eligibility.eligible, workspaceKey, provider]);

  // The engine rejects frames whose viewport aspect deviates from the camera,
  // so the measured box is snapped to the snapshot camera's exact aspect.
  const cameraAspect = snapshot
    ? snapshot.snapshot.scene.camera.view.frameWidth / snapshot.snapshot.scene.camera.view.frameHeight
    : null;

  useEffect(() => {
    if (!canvasEl || cameraAspect === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = canvasEl.getBoundingClientRect();
      setViewport(snapStudioPreviewViewportV1({ height: rect.height, width: rect.width }, cameraAspect));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    return () => {
      observer.disconnect();
      setViewport(null);
    };
  }, [cameraAspect, canvasEl]);

  // Frame evidence is never implicit: it requires a dev/test build AND a
  // provider that explicitly wires the dev client extension (the checked-in
  // fixture harness). A server provider stays extension-free.
  const evidenceAdapter = import.meta.env.DEV ? (provider?.evidence ?? null) : null;

  useEffect(() => {
    if (!eligibility.eligible || !provider || !snapshot || !canvasEl || workspaceKey === null) return;
    if (!claimStudioPreviewCanvasV1(canvasEl)) {
      setEpoch((current) => current + 1);
      return;
    }
    const binding: StudioPreviewHostBindingV1 = { canvas: canvasEl, provider, snapshot, workspaceKey };
    const nextHost = new StudioPreviewRendererHost({
      createRenderer: () => createCanvasPreviewRendererV1(evidenceAdapter ? { evidence: evidenceAdapter } : {}),
      onStateChange: (state) => {
        setBound((current) => (current?.binding === binding ? { binding, host: nextHost, state } : current));
      },
    });
    setBound({ binding, host: nextHost, state: nextHost.state });
    void nextHost.install({
      canvas: canvasEl,
      revision: snapshot.correlation.engineRevisionHash,
      snapshot: snapshot.snapshot,
    });
    return () => {
      // Cleanup invalidates the binding immediately: an old host's presented
      // state can never authorize paint on a remounted canvas or new snapshot.
      nextHost.dispose();
      setBound((current) => (current?.binding === binding ? null : current));
      setEpoch((current) => current + 1);
    };
  }, [canvasEl, eligibility.eligible, evidenceAdapter, provider, workspaceKey, snapshot]);

  const host = bound?.host ?? null;
  useEffect(() => {
    host?.requestFrame({ sampleTime, viewport });
  }, [host, sampleTime, viewport]);

  useEffect(() => {
    host?.setTransientEdit(transientEdit);
  }, [host, transientEdit]);

  // Dev/test-only: expose the host-bound frame evidence channel so E2E can
  // prove the retained worker's own pixels. Requires the provider capability;
  // never present in production.
  useEffect(() => {
    if (!evidenceAdapter || !host) return;
    const scope = globalThis as Record<string, unknown>;
    scope.__poietraPreviewFrameEvidence = (samples: CaptureCanvasFrameEvidenceInputV1["samples"]) =>
      host.captureEvidence(samples);
    return () => {
      delete scope.__poietraPreviewFrameEvidence;
    };
  }, [evidenceAdapter, host]);

  // The host emission is only trusted when its binding matches this render's
  // exact canvas element, provider, snapshot, and workspace key.
  const bindingCurrent =
    bound !== null &&
    provider !== null &&
    snapshot !== null &&
    canvasEl !== null &&
    workspaceKey !== null &&
    studioPreviewHostBindingCurrentV1(bound.binding, { canvas: canvasEl, provider, snapshot, workspaceKey });

  // Every gate — transient edit, snapshot correlation, host binding, and exact
  // frame match against this render's own playhead and viewport — is applied
  // synchronously here, so the first paint after a scrub, resize, drag start,
  // canvas remount, or host teardown never trusts a stale presented emission.
  const state = useMemo<PreviewRendererHostStateV1>(
    () =>
      resolveStudioPreviewViewStateV1({
        context,
        eligibility,
        hostActive: bindingCurrent,
        hostState: bound !== null && bindingCurrent ? bound.state : INSTALLING_STATE,
        sampleTime,
        snapshot,
        snapshotError,
        transientEdit,
        viewport,
      }),
    [bindingCurrent, bound, context, eligibility, sampleTime, snapshot, snapshotError, transientEdit, viewport],
  );

  // Geometry is projected for the exact presented sample time and only under
  // the static-Scene guarantee; outside it the map is empty and the semantic
  // hit targets stay authoritative.
  const interactionGeometry = useMemo(
    () =>
      state.phase === "presented" && snapshot
        ? projectStudioPreviewStaticInteractionGeometryV1(snapshot.snapshot.scene, frame, state.frame.sampleTime)
        : null,
    [frame, snapshot, state],
  );

  if (!provider) return null;
  return { attachCanvas, epoch, interactionGeometry, sourceLabel: snapshot?.sourceLabel ?? null, state };
}
