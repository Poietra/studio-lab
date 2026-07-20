export type TimeAnchor =
  | Readonly<{ kind: "absolute"; seconds: number }>
  | Readonly<{ kind: "playhead"; referenceSeconds: number }>
  | Readonly<{ kind: "playhead-offset"; offsetSeconds: number; referenceSeconds: number }>
  | Readonly<{
      boundary: "play-end" | "play-start" | "scene-end" | "scene-start";
      eventId: string;
      kind: "structural";
      offsetSeconds?: number;
    }>;

export type ResolvedTimeAnchor = Readonly<{
  capturedPlayhead: number;
  evidence: readonly string[];
  resolvedSeconds: number;
  source: TimeAnchor;
}>;

export type TimeResolutionContext = Readonly<{
  capturedPlayhead: number;
  sceneDuration: number;
  structuralBoundaries?: Readonly<Record<string, number>>;
}>;

export type TimeResolutionResult =
  | Readonly<{ anchor: ResolvedTimeAnchor; kind: "resolved" }>
  | Readonly<{ field: "anchor"; kind: "invalid"; message: string }>;

const EPSILON = 0.001;

export function resolveTimeAnchorOnce(
  source: TimeAnchor,
  context: TimeResolutionContext,
): TimeResolutionResult {
  let resolvedSeconds: number;
  const evidence: string[] = [`captured-playhead:${context.capturedPlayhead.toFixed(3)}`];

  if (source.kind === "absolute") {
    resolvedSeconds = source.seconds;
    evidence.push(`absolute:${source.seconds.toFixed(3)}`);
  } else if (source.kind === "playhead") {
    if (Math.abs(source.referenceSeconds - context.capturedPlayhead) >= EPSILON) {
      return { field: "anchor", kind: "invalid", message: "anchor.referenceSeconds does not match the captured playhead." };
    }
    resolvedSeconds = source.referenceSeconds;
    evidence.push(`playhead:${source.referenceSeconds.toFixed(3)}`);
  } else if (source.kind === "playhead-offset") {
    if (Math.abs(source.referenceSeconds - context.capturedPlayhead) >= EPSILON) {
      return { field: "anchor", kind: "invalid", message: "anchor.referenceSeconds does not match the captured playhead." };
    }
    resolvedSeconds = source.referenceSeconds + source.offsetSeconds;
    evidence.push(`playhead-offset:${source.offsetSeconds.toFixed(3)}`);
  } else {
    const boundary = context.structuralBoundaries?.[source.eventId];
    if (boundary === undefined) {
      return { field: "anchor", kind: "invalid", message: `anchor.eventId ${source.eventId} is not a known structural boundary.` };
    }
    resolvedSeconds = boundary + (source.offsetSeconds ?? 0);
    evidence.push(`structural:${source.boundary}:${source.eventId}`);
  }

  if (!Number.isFinite(resolvedSeconds) || resolvedSeconds < 0 || resolvedSeconds > context.sceneDuration) {
    return { field: "anchor", kind: "invalid", message: "anchor resolves outside the active Scene." };
  }

  return {
    anchor: {
      capturedPlayhead: context.capturedPlayhead,
      evidence,
      resolvedSeconds,
      source,
    },
    kind: "resolved",
  };
}

export function timeAnchorLabel(anchor: ResolvedTimeAnchor | TimeAnchor) {
  const source = "source" in anchor ? anchor.source : anchor;
  const resolved = "resolvedSeconds" in anchor ? ` → ${anchor.resolvedSeconds.toFixed(2)}s` : "";
  if (source.kind === "absolute") return `absolute ${source.seconds.toFixed(2)}s${resolved}`;
  if (source.kind === "playhead") return `captured playhead ${source.referenceSeconds.toFixed(2)}s${resolved}`;
  if (source.kind === "playhead-offset") {
    return `playhead ${source.referenceSeconds.toFixed(2)}s ${source.offsetSeconds.toFixed(2)}s${resolved}`;
  }
  return `${source.boundary} (${source.eventId})${source.offsetSeconds ? ` ${source.offsetSeconds.toFixed(2)}s` : ""}${resolved}`;
}
