import type { Point, PropertyChannelSample, PropertyValue } from "./model";

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

export function isPointValue(value: unknown): value is Point {
  return typeof value === "object" && value !== null && "x" in value && "y" in value;
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
    const progress = duration <= 0
      ? 1
      : smooth(Math.min(1, Math.max(0, (time - sample.interval.start) / duration)));
    if (isPointValue(sample.from) && isPointValue(sample.value)) {
      const control = sample.control ?? {
        x: (sample.from.x + sample.value.x) / 2,
        y: (sample.from.y + sample.value.y) / 2,
      };
      const inverse = 1 - progress;
      value = {
        x: inverse * inverse * sample.from.x + 2 * inverse * progress * control.x + progress * progress * sample.value.x,
        y: inverse * inverse * sample.from.y + 2 * inverse * progress * control.y + progress * progress * sample.value.y,
      };
    } else if (typeof sample.from === "number" && typeof sample.value === "number") {
      value = sample.from + (sample.value - sample.from) * progress;
    } else {
      value = sample.value;
    }
  }
  return value;
}
