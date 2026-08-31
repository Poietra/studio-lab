import { applyEngineEasingV1 } from "../engine/easing";
import type { EntityDimensions, Knowledge, Point, PropertyChannelSample, PropertyValue, Unknown } from "./model";

function isCoordinateAxis(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const axis = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(axis).length === 3 &&
    [axis.minimum, axis.maximum, axis.step].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    typeof axis.step === "number" &&
    axis.step > 0
  );
}

function isCoordinateSystem(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const system = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(system).every((key) => key === "x" || key === "y") &&
    isCoordinateAxis(system.x) &&
    (system.y === undefined || isCoordinateAxis(system.y))
  );
}

function sameCoordinateAxis(
  left: Readonly<{ maximum: number; minimum: number; step: number }>,
  right: Readonly<{ maximum: number; minimum: number; step: number }>,
) {
  return left.maximum === right.maximum && left.minimum === right.minimum && left.step === right.step;
}

function sameCoordinateSystem(
  left: NonNullable<EntityDimensions["coordinateSystem"]>,
  right: NonNullable<EntityDimensions["coordinateSystem"]>,
) {
  return (
    sameCoordinateAxis(left.x, right.x) &&
    (left.y === undefined || right.y === undefined ? left.y === right.y : sameCoordinateAxis(left.y, right.y))
  );
}

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

function easingProgress(sample: PropertyChannelSample, value: number) {
  if (typeof sample.easing === "object") return applyEngineEasingV1(sample.easing, value);
  if (sample.easing === "linear") return value;
  if (sample.easing === "manim-smooth") return applyEngineEasingV1({ kind: "manim-smooth" }, value);
  return smooth(value);
}

export function isPointValue(value: unknown): value is Point {
  return typeof value === "object" && value !== null && "x" in value && "y" in value;
}

export function isEntityDimensionsValue(value: unknown): value is EntityDimensions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  const angles = record.angles;
  const anglesAreValid =
    angles === undefined ||
    (typeof angles === "object" &&
      angles !== null &&
      !Array.isArray(angles) &&
      Object.keys(angles).length === 2 &&
      "start" in angles &&
      "sweep" in angles &&
      typeof angles.start === "number" &&
      Number.isFinite(angles.start) &&
      typeof angles.sweep === "number" &&
      Number.isFinite(angles.sweep));
  const coordinateSystemIsValid = record.coordinateSystem === undefined || isCoordinateSystem(record.coordinateSystem);
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        key === "angles" ||
        key === "coordinateSystem" ||
        key === "cornerRadius" ||
        key === "height" ||
        key === "radius" ||
        key === "sides" ||
        key === "width",
    ) &&
    keys
      .filter((key) => key !== "angles" && key !== "coordinateSystem")
      .every((key) => typeof record[key] === "number" && Number.isFinite(record[key])) &&
    anglesAreValid &&
    coordinateSystemIsValid &&
    (record.sides === undefined ||
      (typeof record.sides === "number" && Number.isInteger(record.sides) && record.sides >= 3 && record.sides <= 32))
  );
}

function interpolateDimensions(from: EntityDimensions, to: EntityDimensions, progress: number) {
  const interpolated = Object.fromEntries(
    (["cornerRadius", "height", "radius", "width"] as const).flatMap((key) => {
      const start = from[key];
      const end = to[key];
      return typeof start === "number" && typeof end === "number"
        ? [[key, start + (end - start) * progress] as const]
        : [];
    }),
  ) as EntityDimensions;
  const withSides =
    from.sides !== undefined && from.sides === to.sides ? { ...interpolated, sides: from.sides } : interpolated;
  const withAngles =
    from.angles !== undefined &&
    to.angles !== undefined &&
    from.angles.start === to.angles.start &&
    from.angles.sweep === to.angles.sweep
      ? { ...withSides, angles: from.angles }
      : withSides;
  return from.coordinateSystem !== undefined &&
    to.coordinateSystem !== undefined &&
    sameCoordinateSystem(from.coordinateSystem, to.coordinateSystem)
    ? { ...withAngles, coordinateSystem: from.coordinateSystem }
    : withAngles;
}

function sameStartPriority(sample: PropertyChannelSample, index: number, baseIndex: number) {
  if (index === baseIndex) return 0;
  if (sample.sameAnchorOrder === "before-studio-insertion") return 1;
  if (sample.operationId !== undefined) return 2;
  return 3;
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
 * Restores source chronology for discrete content replacements.
 *
 * Studio content edits are appended after imported samples during evaluation,
 * even when their source anchor precedes a later `become`. Sorting puts that
 * later source replacement back in authority. At the same instant, the base
 * sample remains first, followed by Studio edits and then source order.
 */
export function normalizeContentSamples(samples: readonly PropertyChannelSample[]): readonly PropertyChannelSample[] {
  return chronologicalSamples(samples).map(({ sample }) => sample);
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
    if (sample.pathMotion !== undefined) {
      // Rust owns arc-length path evaluation. Keep the last exact endpoint in
      // the semantic projection rather than inventing a quadratic fallback.
      value = sample.from;
    } else if (isPointValue(sample.from) && isPointValue(sample.value)) {
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
