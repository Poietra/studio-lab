import type { EntityDimensions, Knowledge, Point, PropertyChannelSample, PropertyValue, Unknown } from "./model";

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

function easingProgress(sample: PropertyChannelSample, value: number) {
  return sample.easing === "linear" ? value : smooth(value);
}

export function isPointValue(value: unknown): value is Point {
  return typeof value === "object" && value !== null && "x" in value && "y" in value;
}

export function isEntityDimensionsValue(value: unknown): value is EntityDimensions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  return (
    keys.length > 0 &&
    keys.every((key) => key === "height" || key === "radius" || key === "width") &&
    keys.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))
  );
}

function interpolateDimensions(from: EntityDimensions, to: EntityDimensions, progress: number) {
  return Object.fromEntries(
    (["height", "radius", "width"] as const).flatMap((key) => {
      const start = from[key];
      const end = to[key];
      return typeof start === "number" && typeof end === "number"
        ? [[key, start + (end - start) * progress] as const]
        : [];
    }),
  ) as EntityDimensions;
}

function sameStartPriority(sample: PropertyChannelSample, index: number, baseIndex: number) {
  if (index === baseIndex) return 0;
  if (sample.operationId !== undefined) return 1;
  return 2;
}

function chronologicalSamples(samples: readonly PropertyChannelSample[]) {
  const firstStart = Math.min(...samples.map((sample) => sample.interval.start));
  const baseIndex = samples.findIndex(
    (sample) => sample.kind === "exact" && sample.operationId === undefined && sample.interval.start === firstStart,
  );
  return samples
    .map((sample, index) => ({ index, sample }))
    .sort((left, right) => {
      const startDelta = left.sample.interval.start - right.sample.interval.start;
      if (Math.abs(startDelta) >= 0.0005) return startDelta;
      return (
        sameStartPriority(left.sample, left.index, baseIndex) -
          sameStartPriority(right.sample, right.index, baseIndex) || left.index - right.index
      );
    });
}

/**
 * Restores source order for absolute shape geometry mutations.
 *
 * A Studio resize is appended after imported samples even when its source
 * anchor precedes them. Later source resizes must therefore be put back after
 * the Studio sample. Animated source resizes start from the geometry produced
 * by everything before them, while an unknown mutation keeps its Unknown
 * knowledge and uses that geometry only as a stable preview placeholder.
 */
export function normalizeDimensionsSamples(
  samples: readonly PropertyChannelSample[],
): readonly PropertyChannelSample[] {
  const normalized: PropertyChannelSample[] = [];
  for (const { sample } of chronologicalSamples(samples)) {
    const current = samplePropertyValue(normalized, sample.interval.start);
    if (!isEntityDimensionsValue(current)) {
      normalized.push(sample);
      continue;
    }
    if (sample.knowledge?.kind === "unknown") {
      normalized.push({
        ...sample,
        ...(sample.kind === "animated" ? { from: current } : {}),
        value: current,
      });
      continue;
    }
    normalized.push(
      sample.kind === "animated" && isEntityDimensionsValue(sample.from) ? { ...sample, from: current } : sample,
    );
  }
  return normalized;
}

/**
 * Restores the chronological, relative semantics of Manim shift/path motions.
 *
 * Source-imported motions retain their original delta and control offset. When
 * Studio inserts an operation before one of those motions, this pass rebases
 * the later motion on the position produced by everything that now precedes it.
 */
export function normalizePositionSamples(samples: readonly PropertyChannelSample[]): readonly PropertyChannelSample[] {
  const normalized: PropertyChannelSample[] = [];
  for (const { sample } of chronologicalSamples(samples)) {
    if (
      sample.kind !== "animated" ||
      sample.relative !== true ||
      !isPointValue(sample.from) ||
      !isPointValue(sample.value)
    ) {
      normalized.push(sample);
      continue;
    }
    const sampledFrom = samplePropertyValue(normalized, sample.interval.start);
    const from = isPointValue(sampledFrom) ? sampledFrom : sample.from;
    const delta = {
      x: sample.value.x - sample.from.x,
      y: sample.value.y - sample.from.y,
    };
    const value = { x: from.x + delta.x, y: from.y + delta.y };
    const control = sample.control
      ? {
          x: (from.x + value.x) / 2 + sample.control.x - (sample.from.x + sample.value.x) / 2,
          y: (from.y + value.y) / 2 + sample.control.y - (sample.from.y + sample.value.y) / 2,
        }
      : undefined;
    normalized.push({
      ...sample,
      control,
      from,
      knowledge: sample.knowledge?.kind === "known" ? { kind: "known", value } : sample.knowledge,
      value,
    });
  }
  return normalized;
}

/**
 * Restores the chronological, multiplicative semantics of Manim scale calls.
 * Imported `.scale(factor)` operations retain their original relative factor;
 * an inserted absolute Studio scale therefore becomes the base for any source
 * scale that now follows it instead of being overwritten by array order.
 */
export function normalizeScaleSamples(samples: readonly PropertyChannelSample[]): readonly PropertyChannelSample[] {
  const normalized: PropertyChannelSample[] = [];
  for (const { sample } of chronologicalSamples(samples)) {
    if (
      sample.relative !== true ||
      typeof sample.from !== "number" ||
      typeof sample.value !== "number" ||
      !Number.isFinite(sample.from) ||
      !Number.isFinite(sample.value) ||
      sample.from <= 0 ||
      sample.value <= 0
    ) {
      normalized.push(sample);
      continue;
    }
    const sampledFrom = samplePropertyValue(normalized, sample.interval.start);
    if (typeof sampledFrom !== "number" || !Number.isFinite(sampledFrom) || sampledFrom <= 0) {
      normalized.push({
        ...sample,
        knowledge: {
          kind: "unknown",
          reason: "Relative source scale has no finite positive chronological base.",
        },
      });
      continue;
    }
    const factor = sample.value / sample.from;
    const value = sampledFrom * factor;
    if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(value) || value <= 0) {
      normalized.push({
        ...sample,
        knowledge: {
          kind: "unknown",
          reason: "Relative source scale does not produce a finite positive value.",
        },
      });
      continue;
    }
    normalized.push({
      ...sample,
      from: sampledFrom,
      knowledge: sample.knowledge?.kind === "known" ? { kind: "known", value } : sample.knowledge,
      value,
    });
  }
  return normalized;
}

export function samplePropertyKnowledge<T extends EntityDimensions | number | Point>(
  samples: readonly PropertyChannelSample[],
  time: number,
  value: T | undefined,
): Knowledge<T> | undefined {
  let unknownKnowledge: Unknown | undefined;
  for (const sample of samples) {
    if (time < sample.interval.start) continue;
    if (sample.knowledge?.kind === "unknown") unknownKnowledge = sample.knowledge;
    else if (sample.knowledge?.kind === "known") unknownKnowledge = undefined;
  }
  if (unknownKnowledge) return unknownKnowledge;
  return value === undefined ? undefined : { kind: "known", value };
}

export function samplePropertyValue(
  samples: readonly PropertyChannelSample[],
  time: number,
): PropertyValue | undefined {
  let value: PropertyValue | undefined;
  for (const sample of samples) {
    if (time < sample.interval.start) continue;
    if (sample.kind === "exact" || time >= sample.interval.end) {
      value = sample.value;
      continue;
    }
    const duration = sample.interval.end - sample.interval.start;
    const progress =
      duration <= 0 ? 1 : easingProgress(sample, Math.min(1, Math.max(0, (time - sample.interval.start) / duration)));
    if (isPointValue(sample.from) && isPointValue(sample.value)) {
      const control = sample.control ?? {
        x: (sample.from.x + sample.value.x) / 2,
        y: (sample.from.y + sample.value.y) / 2,
      };
      const inverse = 1 - progress;
      value = {
        x:
          inverse * inverse * sample.from.x + 2 * inverse * progress * control.x + progress * progress * sample.value.x,
        y:
          inverse * inverse * sample.from.y + 2 * inverse * progress * control.y + progress * progress * sample.value.y,
      };
    } else if (typeof sample.from === "number" && typeof sample.value === "number") {
      value = sample.from + (sample.value - sample.from) * progress;
    } else if (isEntityDimensionsValue(sample.from) && isEntityDimensionsValue(sample.value)) {
      value = interpolateDimensions(sample.from, sample.value, progress);
    } else {
      value = sample.value;
    }
  }
  return value;
}
