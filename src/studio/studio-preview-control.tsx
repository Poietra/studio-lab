import type { PreviewFallbackReasonV1 } from "../engine/preview-renderer";
import { cn } from "../lib/cn";
import { describeStudioPreviewFallbackV1 } from "./preview-renderer-policy";
import type { StudioPreviewRendererViewV1 } from "./use-preview-renderer";

export type StudioPreviewControlStateV1 = Readonly<{
  detail: string | null;
  kind: "awaiting-consent" | "failed" | "idle" | "loading" | "presented" | "semantic-fallback" | "unsupported";
  retryable: boolean;
}>;

type ResolveStudioPreviewControlStateInputV1 = Readonly<{
  activationRequested: boolean;
  activated: boolean;
  providerPending: boolean;
  renderer: StudioPreviewRendererViewV1 | null;
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

/** Maps retained-renderer internals onto the small set of truthful states the
 * standard editor control exposes. Only an exactly correlated presented frame
 * receives the verified label; every fallback keeps semantic paint active. */
export function resolveStudioPreviewControlStateV1(
  input: ResolveStudioPreviewControlStateInputV1,
): StudioPreviewControlStateV1 {
  if (!input.activationRequested) return { detail: null, kind: "idle", retryable: false };
  if (!input.activated) return { detail: null, kind: "awaiting-consent", retryable: false };
  if (input.providerPending)
    return { detail: "Resolving the Manim preview provider.", kind: "loading", retryable: false };
  if (!input.renderer) {
    return { detail: "The requested Manim preview provider is unavailable.", kind: "failed", retryable: true };
  }
  if (input.renderer.state.phase === "presented") {
    return { detail: input.renderer.sourceLabel, kind: "presented", retryable: false };
  }
  const { detail, reason } = input.renderer.state;
  const fallbackDetail = detail ?? describeStudioPreviewFallbackV1(reason);
  if (reason === "capability-unsupported") {
    return { detail: fallbackDetail, kind: "unsupported", retryable: false };
  }
  if (reason === "snapshot-unavailable") {
    return input.renderer.sourceMetadataFailureKind === "unsupported"
      ? { detail: fallbackDetail, kind: "unsupported", retryable: false }
      : { detail: fallbackDetail, kind: "failed", retryable: true };
  }
  if (FAILED_FALLBACKS.has(reason)) return { detail: fallbackDetail, kind: "failed", retryable: true };
  if (LOADING_FALLBACKS.has(reason)) return { detail: fallbackDetail, kind: "loading", retryable: false };
  return { detail: fallbackDetail, kind: "semantic-fallback", retryable: false };
}

export type StudioPreviewControlPropsV1 = ResolveStudioPreviewControlStateInputV1 &
  Readonly<{
    activationAllowed: boolean;
    disabled?: boolean;
    onRequest: () => void;
    onRetry: () => void;
  }>;

const STATE_LABELS: Readonly<Record<StudioPreviewControlStateV1["kind"], string>> = {
  "awaiting-consent": "Manim Preview · Off",
  failed: "Manim Preview · Failed",
  idle: "Manim Preview",
  loading: "Manim Preview · Loading…",
  presented: "Manim Preview · Verified",
  "semantic-fallback": "Manim Preview · Semantic fallback",
  unsupported: "Manim Preview · Unsupported",
};

export function StudioPreviewControl({
  activationAllowed,
  activationRequested,
  activated,
  disabled = false,
  onRequest,
  onRetry,
  providerPending,
  renderer,
}: StudioPreviewControlPropsV1) {
  const state = resolveStudioPreviewControlStateV1({
    activationRequested,
    activated,
    providerPending,
    renderer,
  });
  if (state.kind === "awaiting-consent") return null;
  if (state.kind === "idle") {
    return (
      <button
        aria-controls="enable-preview-dialog"
        aria-haspopup="dialog"
        className="border border-sky-900 px-2 py-1 font-medium text-sky-300 hover:bg-sky-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
        data-studio-manim-preview-state="idle"
        disabled={disabled || !activationAllowed}
        onClick={onRequest}
        title={
          activationAllowed
            ? "Run the selected trusted Manim Scene after confirmation."
            : "Open Studio in a top-level tab to enable preview."
        }
        type="button"
      >
        Manim Preview
      </button>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-1 border px-2 py-1",
        state.kind === "presented" && "border-emerald-900 text-emerald-300",
        state.kind === "loading" && "border-sky-900 text-sky-300",
        state.kind === "semantic-fallback" && "border-amber-900 text-amber-300",
        (state.kind === "failed" || state.kind === "unsupported") && "border-red-900 text-red-300",
      )}
      data-studio-manim-preview-state={state.kind}
      role="status"
      title={state.detail ?? undefined}
    >
      <span>{STATE_LABELS[state.kind]}</span>
      {state.retryable ? (
        <button
          className="ml-1 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
