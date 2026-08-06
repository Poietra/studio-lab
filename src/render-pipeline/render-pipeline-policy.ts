import type { CanonicalEditProgram } from "../studio/operations";
import {
  type ManimRenderCapability,
  type ManimWorkspaceView,
  type ProgramRenderRequest,
  type RenderSessionView,
  renderProgramBatchId,
  renderRequestId,
} from "./contracts";

export type RenderProgramCandidate = Readonly<{
  anchors: readonly number[];
  cameraCenter?: ProgramRenderRequest["cameraCenter"];
  destination: ProgramRenderRequest["destination"];
  program: CanonicalEditProgram;
  programs: readonly CanonicalEditProgram[];
  projectId: string;
  sceneName: string;
  sourceBindings: ProgramRenderRequest["sourceBindings"];
  sourceHash: string;
  sourcePath: string;
  /** Producer-backed t=0 authority for one exact initial-edit slice. */
  verifiedInitialEditAnchor?: 0;
  /** Correlated Runtime Trace authority for the sealed Updaters terminal edit. */
  verifiedRuntimeTraceTerminalEditAnchor?: 5;
  viewport: ProgramRenderRequest["viewport"];
}>;

export type RenderSourceIdentity = Readonly<{
  projectId: string;
  sceneName: string;
  sourceHash: string;
  sourcePath: string;
}>;

export type RenderSourceRefreshTarget = RenderSourceIdentity &
  Readonly<{
    resultSourceHash: string;
  }>;

export type RenderPipelineAction = "cancel" | "commit" | "discard" | "export" | "render" | "undo";

export type RenderPipelinePolicy = Readonly<{
  commitBlocker: string | null;
  exportBlocker: string | null;
  previewBlocker: string | null;
  sessionMatchesCandidate: boolean;
}>;

export function renderCandidateRequest(candidate: RenderProgramCandidate): ProgramRenderRequest {
  return {
    ...(candidate.cameraCenter ? { cameraCenter: candidate.cameraCenter } : {}),
    destination: candidate.destination,
    program: candidate.program,
    programs: candidate.programs,
    projectId: candidate.projectId,
    sceneName: candidate.sceneName,
    sourceBindings: candidate.sourceBindings,
    sourceHash: candidate.sourceHash,
    sourcePath: candidate.sourcePath,
    viewport: candidate.viewport,
  };
}

export function renderCandidateRequestKey(candidate: RenderProgramCandidate) {
  return JSON.stringify({
    anchors: candidate.anchors,
    request: renderCandidateRequest(candidate),
    verifiedInitialEditAnchor: candidate.verifiedInitialEditAnchor ?? null,
    verifiedRuntimeTraceTerminalEditAnchor: candidate.verifiedRuntimeTraceTerminalEditAnchor ?? null,
  });
}

export function renderCandidateMissingAnchor(candidate: RenderProgramCandidate | null) {
  return (
    candidate?.programs.find(
      (program) =>
        !candidate.anchors.some((anchor) => Math.abs(anchor - program.anchor.resolvedSeconds) < 0.0005) &&
        candidate.verifiedInitialEditAnchor !== program.anchor.resolvedSeconds &&
        candidate.verifiedRuntimeTraceTerminalEditAnchor !== program.anchor.resolvedSeconds,
    )?.anchor.resolvedSeconds ?? null
  );
}

export function renderSourceMutationOutcome(
  previousStatus: RenderSessionView["status"],
  nextStatus: RenderSessionView["status"],
): "committed" | "undone" | null {
  if (previousStatus === "ready" && nextStatus === "committed") return "committed";
  if (previousStatus === "committed" && nextStatus === "undone") return "undone";
  return null;
}

export function renderSourceRefreshTarget(
  session: RenderSessionView,
  outcome: "committed" | "undone",
): RenderSourceRefreshTarget {
  return {
    projectId: session.projectId,
    resultSourceHash: outcome === "committed" ? session.patch.patchedSourceHash : session.patch.sourceHash,
    sceneName: session.sceneName,
    sourceHash: outcome === "committed" ? session.patch.sourceHash : session.patch.patchedSourceHash,
    sourcePath: session.sourcePath,
  };
}

export function renderSourceRefreshResolved(target: RenderSourceRefreshTarget, workspace: ManimWorkspaceView) {
  if (workspace.projectId !== target.projectId) return false;
  const source = workspace.sources.find((candidate) => candidate.path === target.sourcePath);
  return (
    source?.scenes.some((scene) => scene.name === target.sceneName && scene.sourceHash === target.resultSourceHash) ===
    true
  );
}

export function renderSourceRefreshMatches(
  target: RenderSourceRefreshTarget,
  activeSource: RenderSourceIdentity | null,
) {
  return (
    activeSource !== null &&
    target.projectId === activeSource.projectId &&
    target.sceneName === activeSource.sceneName &&
    target.sourceHash === activeSource.sourceHash &&
    target.sourcePath === activeSource.sourcePath
  );
}

export function renderSessionMatchesCandidate(
  session: RenderSessionView | null,
  candidate: RenderProgramCandidate | null,
) {
  return (
    session !== null &&
    candidate !== null &&
    session.projectId === candidate.projectId &&
    session.programBatchId === renderProgramBatchId(candidate.programs) &&
    session.renderRequestId === renderRequestId(renderCandidateRequest(candidate)) &&
    session.patch.sourceHash === candidate.sourceHash &&
    session.sourcePath === candidate.sourcePath &&
    session.sceneName === candidate.sceneName
  );
}

export function resolveRenderPipelinePolicy(
  input: Readonly<{
    candidate: RenderProgramCandidate | null;
    candidateBlocker: string | null;
    candidateLifecycleBlocker: string | null;
    originalExportBlocker: string | null;
    renderCapability: ManimRenderCapability | null;
    session: RenderSessionView | null;
  }>,
): RenderPipelinePolicy {
  const sessionMatchesCandidate = renderSessionMatchesCandidate(input.session, input.candidate);
  const previewBlocker =
    input.candidateLifecycleBlocker ?? input.candidateBlocker ?? renderCapabilityBlocker(input.renderCapability);
  const exportBlocker = input.candidate
    ? (input.candidateLifecycleBlocker ?? input.candidateBlocker)
    : input.originalExportBlocker;
  const commitBlocker = input.session?.canCommit
    ? (input.candidateLifecycleBlocker ??
      (!sessionMatchesCandidate
        ? "This rendered preview no longer matches the active Studio candidate. Discard it before continuing."
        : input.candidateBlocker))
    : null;
  return { commitBlocker, exportBlocker, previewBlocker, sessionMatchesCandidate };
}

export function renderCapabilityBlocker(capability: ManimRenderCapability | null) {
  if (!capability) return "Inspecting the render service…";
  if (capability.available) return null;
  if (capability.unavailableReason === "local-command-unavailable") {
    return "The configured Manim command is unavailable.";
  }
  if (capability.unavailableReason === "durable-render-unconfigured") {
    return "Durable rendering is not configured for this workspace.";
  }
  return "The durable render service is temporarily unavailable.";
}

export function renderPipelineActionBlocker(action: RenderPipelineAction, policy: RenderPipelinePolicy): string | null {
  if (action === "commit") return policy.commitBlocker;
  if (action === "export") return policy.exportBlocker;
  if (action === "render") return policy.previewBlocker;
  return null;
}
