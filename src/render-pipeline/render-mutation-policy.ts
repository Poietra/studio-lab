import type { RenderPipelinePolicy } from "./render-pipeline-policy";

export type RenderMutationTarget =
  | Readonly<{ action: "commit"; candidateKey: string; sessionId: string }>
  | Readonly<{ action: "export-candidate"; candidateKey: string }>
  | Readonly<{ action: "export-source"; sourceExportKey: string }>
  | Readonly<{ action: "render"; candidateKey: string }>
  | Readonly<{ action: "cancel" | "discard" | "undo"; sessionId: string }>;

export type RenderPipelineMutationContext = Readonly<{
  candidateKey: string | null;
  policy: RenderPipelinePolicy;
  sessionCanCommit: boolean;
  sessionId: string | null;
  sourceExportKey: string | null;
}>;

export function mutationTargetIsCurrent(target: RenderMutationTarget, context: RenderPipelineMutationContext) {
  switch (target.action) {
    case "commit":
      return (
        context.policy.commitBlocker === null &&
        context.candidateKey === target.candidateKey &&
        context.sessionCanCommit &&
        context.sessionId === target.sessionId
      );
    case "export-candidate":
      return context.policy.exportBlocker === null && context.candidateKey === target.candidateKey;
    case "export-source":
      return context.policy.exportBlocker === null && context.sourceExportKey === target.sourceExportKey;
    case "render":
      return context.policy.previewBlocker === null && context.candidateKey === target.candidateKey;
    default:
      return context.sessionId === target.sessionId;
  }
}

export function mutationMayBeAborted(target: RenderMutationTarget) {
  return (
    target.action === "commit" ||
    target.action === "export-candidate" ||
    target.action === "export-source" ||
    target.action === "undo"
  );
}
