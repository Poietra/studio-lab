import type { PreviewFallbackReasonV1 } from "../engine/preview-renderer";
import { cn } from "../lib/cn";
import { describeStudioPreviewFallback } from "./preview-renderer-policy";
import type { StudioPreviewRendererView } from "./use-preview-renderer";

export type StudioPreviewControlState = Readonly<{
  detail: string | null;
  kind: "failed" | "loading" | "paused" | "presented" | "unsupported";
  retryable: boolean;
}>;

type ResolveStudioPreviewControlStateInput = Readonly<{
  providerPending: boolean;
  renderer: StudioPreviewRendererView | null;
}>;

const LOADING_FALLBACKS: ReadonlySet<PreviewFallbackReasonV1> = new Set([
  "frame-pending",
  "frame-stale",
  "installing",
  "viewport-unavailable",
]);
const FAILED_FALLBACKS: ReadonlySet<PreviewFallbackReasonV1> = new Set([
  "install-failed",
  "render-error",
  "renderer-failed",
]);

/** Maps retained-renderer internals onto truthful canonical-preview states.
 * Only an exactly correlated presented frame receives the verified label;
 * every other state says that WebGPU paint is absent or temporarily paused. */
export function resolveStudioPreviewControlState(
  input: ResolveStudioPreviewControlStateInput,
): StudioPreviewControlState {
  if (input.providerPending)
    return { detail: "Resolving the Manim preview provider.", kind: "loading", retryable: false };
  if (!input.renderer) {
    return { detail: "The requested Manim preview provider is unavailable.", kind: "failed", retryable: true };
  }
  if (input.renderer.state.phase === "presented") {
    return { detail: input.renderer.sourceLabel, kind: "presented", retryable: false };
  }
  const { detail, reason } = input.renderer.state;
  const fallbackDetail = detail ?? describeStudioPreviewFallback(reason);
  if (
    reason === "capability-unsupported" ||
    reason === "disposed" ||
    reason === "sample-out-of-range" ||
    reason === "scene-unsupported"
  ) {
    return { detail: fallbackDetail, kind: "unsupported", retryable: false };
  }
  if (reason === "snapshot-unavailable") {
    return input.renderer.sourceMetadataFailureKind === "unsupported"
      ? { detail: fallbackDetail, kind: "unsupported", retryable: false }
      : { detail: fallbackDetail, kind: "failed", retryable: true };
  }
  if (FAILED_FALLBACKS.has(reason)) return { detail: fallbackDetail, kind: "failed", retryable: true };
  if (LOADING_FALLBACKS.has(reason)) return { detail: fallbackDetail, kind: "loading", retryable: false };
  return { detail: fallbackDetail, kind: "paused", retryable: false };
}

export type StudioPreviewControlProps = ResolveStudioPreviewControlStateInput &
  Readonly<{
    disabled?: boolean;
    onRetry: () => void;
  }>;

const STATE_LABELS: Readonly<Record<StudioPreviewControlState["kind"], string>> = {
  failed: "WebGPU Preview · Failed",
  loading: "WebGPU Preview · Loading…",
  paused: "WebGPU Preview · Updating",
  presented: "WebGPU Preview · Verified",
  unsupported: "WebGPU Preview · Unsupported",
};

export function StudioPreviewControl({
  disabled = false,
  onRetry,
  providerPending,
  renderer,
}: StudioPreviewControlProps) {
  const state = resolveStudioPreviewControlState({
    providerPending,
    renderer,
  });
  return (
    <div
      className={cn(
        "flex items-center gap-1 border px-2 py-1",
        state.kind === "presented" && "border-emerald-900 text-emerald-300",
        state.kind === "loading" && "border-sky-900 text-sky-300",
        state.kind === "paused" && "border-amber-900 text-amber-300",
        (state.kind === "failed" || state.kind === "unsupported") && "border-red-900 text-red-300",
      )}
      data-studio-manim-preview-state={state.kind}
      role="status"
      title={state.detail ?? undefined}
    >
      <span>{STATE_LABELS[state.kind]}</span>
      {state.retryable ? (
        <button
          className="ml-1 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600"
          disabled={disabled}
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
