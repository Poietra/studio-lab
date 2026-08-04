import type { CubicPathV1, EngineAffineTransformV1, EnginePointV1 } from "./primitives";
import type { SceneEntityGeometryV1 } from "./scene-ir";

export const PATH_ARC_SUBDIVISIONS_V1 = 64;
export const MANIM_CURVE_LENGTH_SAMPLE_POINTS_V1 = 10;
const TANGENT_EPSILON_V1 = 1e-12;

export class EngineGeometryEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineGeometryEvaluationError";
  }
}

type CubicSegmentV1 = CubicPathV1["subpaths"][number]["segments"][number];

function add(left: EnginePointV1, right: EnginePointV1): EnginePointV1 {
  return { x: left.x + right.x, y: left.y + right.y };
}

function subtract(left: EnginePointV1, right: EnginePointV1): EnginePointV1 {
  return { x: left.x - right.x, y: left.y - right.y };
}

function scale(point: EnginePointV1, factor: number): EnginePointV1 {
  return { x: point.x * factor, y: point.y * factor };
}

function interpolatePoint(left: EnginePointV1, right: EnginePointV1, progress: number): EnginePointV1 {
  return add(left, scale(subtract(right, left), progress));
}

function distance(left: EnginePointV1, right: EnginePointV1) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function lineSegment(start: EnginePointV1, end: EnginePointV1): CubicSegmentV1 {
  const delta = subtract(end, start);
  return {
    control1: add(start, scale(delta, 1 / 3)),
    control2: add(start, scale(delta, 2 / 3)),
    end,
  };
}

export function pointOnCubicV1(start: EnginePointV1, segment: CubicSegmentV1, parameter: number): EnginePointV1 {
  const inverse = 1 - parameter;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse * inverse * parameter * segment.control1.x +
      3 * inverse * parameter * parameter * segment.control2.x +
      parameter ** 3 * segment.end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse * inverse * parameter * segment.control1.y +
      3 * inverse * parameter * parameter * segment.control2.y +
      parameter ** 3 * segment.end.y,
  };
}

function tangentOnCubic(start: EnginePointV1, segment: CubicSegmentV1, parameter: number): EnginePointV1 {
  const inverse = 1 - parameter;
  return {
    x:
      3 * inverse * inverse * (segment.control1.x - start.x) +
      6 * inverse * parameter * (segment.control2.x - segment.control1.x) +
      3 * parameter * parameter * (segment.end.x - segment.control2.x),
    y:
      3 * inverse * inverse * (segment.control1.y - start.y) +
      6 * inverse * parameter * (segment.control2.y - segment.control1.y) +
      3 * parameter * parameter * (segment.end.y - segment.control2.y),
  };
}

function splitCubicPrefix(start: EnginePointV1, segment: CubicSegmentV1, parameter: number): CubicSegmentV1 {
  const first = interpolatePoint(start, segment.control1, parameter);
  const second = interpolatePoint(segment.control1, segment.control2, parameter);
  const third = interpolatePoint(segment.control2, segment.end, parameter);
  const fourth = interpolatePoint(first, second, parameter);
  const fifth = interpolatePoint(second, third, parameter);
  return { control1: first, control2: fourth, end: interpolatePoint(fourth, fifth, parameter) };
}

type CubicMeasurement = Readonly<{
  length: number;
  samples: readonly number[];
}>;

function measureCubic(start: EnginePointV1, segment: CubicSegmentV1): CubicMeasurement {
  const samples = [0];
  let length = 0;
  let previous = start;
  for (let index = 1; index <= PATH_ARC_SUBDIVISIONS_V1; index += 1) {
    const point = pointOnCubicV1(start, segment, index / PATH_ARC_SUBDIVISIONS_V1);
    length += distance(previous, point);
    samples.push(length);
    previous = point;
  }
  return { length, samples };
}

function parameterAtLength(measurement: CubicMeasurement, target: number) {
  if (measurement.length === 0 || target <= 0) return 0;
  if (target >= measurement.length) return 1;
  const index = measurement.samples.findIndex((length) => length >= target);
  const upperIndex = Math.max(1, index);
  const lowerLength = measurement.samples[upperIndex - 1];
  const upperLength = measurement.samples[upperIndex];
  const local = upperLength === lowerLength ? 0 : (target - lowerLength) / (upperLength - lowerLength);
  return (upperIndex - 1 + local) / PATH_ARC_SUBDIVISIONS_V1;
}

function serializedCubicEntriesBySubpath(path: CubicPathV1) {
  return path.subpaths.map((subpath, subpathIndex) => {
    const entries: Array<
      Readonly<{
        closing: boolean;
        segment: CubicSegmentV1;
        start: EnginePointV1;
        subpathIndex: number;
      }>
    > = [];
    let start = subpath.start;
    for (const segment of subpath.segments) {
      entries.push({ closing: false, segment, start, subpathIndex });
      start = segment.end;
    }
    return entries;
  });
}

function cubicEntriesBySubpath(path: CubicPathV1) {
  return serializedCubicEntriesBySubpath(path).map((entries, subpathIndex) => {
    const subpath = path.subpaths[subpathIndex];
    const start = subpath.segments.at(-1)?.end ?? subpath.start;
    if (subpath.closed && distance(start, subpath.start) > 0) {
      const segment = lineSegment(start, subpath.start);
      entries.push({ closing: true, segment, start, subpathIndex });
    }
    return entries;
  });
}

function measuredSegmentEntriesBySubpath(path: CubicPathV1) {
  return cubicEntriesBySubpath(path).map((entries) =>
    entries.map((entry) => ({ ...entry, measurement: measureCubic(entry.start, entry.segment) })),
  );
}

function segmentEntries(path: CubicPathV1) {
  return measuredSegmentEntriesBySubpath(path).flat();
}

function degeneratePath(point: EnginePointV1): CubicPathV1 {
  return {
    subpaths: [{ closed: false, segments: [{ control1: point, control2: point, end: point }], start: point }],
  };
}

export function trimCubicPathV1(path: CubicPathV1, progress: number): CubicPathV1 {
  if (progress >= 1) return path;
  const firstPoint = path.subpaths[0].start;
  if (progress <= 0) return degeneratePath(firstPoint);

  const entriesBySubpath = measuredSegmentEntriesBySubpath(path);
  const totalLength = entriesBySubpath.reduce(
    (total, entries) => total + entries.reduce((subtotal, entry) => subtotal + entry.measurement.length, 0),
    0,
  );
  if (totalLength === 0) return degeneratePath(firstPoint);
  let remaining = totalLength * progress;
  const output: Array<CubicPathV1["subpaths"][number]> = [];

  for (let subpathIndex = 0; subpathIndex < path.subpaths.length; subpathIndex += 1) {
    const sourceSubpath = path.subpaths[subpathIndex];
    const outputSegments: CubicSegmentV1[] = [];
    const subpathEntries = entriesBySubpath[subpathIndex];
    for (const entry of subpathEntries) {
      if (remaining >= entry.measurement.length) {
        remaining -= entry.measurement.length;
        if (!entry.closing) outputSegments.push(entry.segment);
        continue;
      }
      const parameter = parameterAtLength(entry.measurement, remaining);
      outputSegments.push(splitCubicPrefix(entry.start, entry.segment, parameter));
      output.push({ closed: false, segments: outputSegments, start: sourceSubpath.start });
      return { subpaths: output };
    }
    output.push({ closed: sourceSubpath.closed, segments: outputSegments, start: sourceSubpath.start });
    if (remaining <= 0) return { subpaths: output };
  }
  return path;
}

/** Returns the prefix obtained by assigning equal progress to each serialized cubic. */
export function trimCubicPathUniformParameterV1(path: CubicPathV1, progress: number): CubicPathV1 {
  if (progress >= 1) return path;
  const firstPoint = path.subpaths[0].start;
  if (progress <= 0) return degeneratePath(firstPoint);

  const entriesBySubpath = serializedCubicEntriesBySubpath(path);
  const entryCount = entriesBySubpath.reduce((total, entries) => total + entries.length, 0);
  if (entryCount === 0) return degeneratePath(firstPoint);

  const extent = entryCount * progress;
  let completeEntries = Math.floor(extent);
  const partialParameter = extent - completeEntries;
  const output: Array<CubicPathV1["subpaths"][number]> = [];

  for (let subpathIndex = 0; subpathIndex < path.subpaths.length; subpathIndex += 1) {
    const sourceSubpath = path.subpaths[subpathIndex];
    const outputSegments: CubicSegmentV1[] = [];
    for (const entry of entriesBySubpath[subpathIndex]) {
      if (completeEntries > 0) {
        completeEntries -= 1;
        if (!entry.closing) outputSegments.push(entry.segment);
        continue;
      }
      if (partialParameter > 0) {
        outputSegments.push(splitCubicPrefix(entry.start, entry.segment, partialParameter));
        output.push({ closed: false, segments: outputSegments, start: sourceSubpath.start });
      } else if (outputSegments.length > 0) {
        output.push({ closed: false, segments: outputSegments, start: sourceSubpath.start });
      }
      return { subpaths: output };
    }
    output.push({ closed: sourceSubpath.closed, segments: outputSegments, start: sourceSubpath.start });
    if (completeEntries === 0 && partialParameter === 0) return { subpaths: output };
  }
  return path;
}

export function sampleCubicPathV1(path: CubicPathV1, progress: number) {
  const entries = segmentEntries(path);
  const totalLength = entries.reduce((total, entry) => total + entry.measurement.length, 0);
  if (entries.length === 0 || totalLength === 0) return { point: path.subpaths[0].start, tangent: null };
  let target = totalLength * Math.min(1, Math.max(0, progress));
  let selectedIndex = entries.length - 1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    selectedIndex = index;
    if (target <= entry.measurement.length) break;
    target -= entry.measurement.length;
  }
  const selected = entries[selectedIndex];
  const parameter = parameterAtLength(selected.measurement, target);
  const point = pointOnCubicV1(selected.start, selected.segment, parameter);
  let tangent = tangentOnCubic(selected.start, selected.segment, parameter);
  const tangentIsZero = () => Math.hypot(tangent.x, tangent.y) <= TANGENT_EPSILON_V1;

  for (let step = 1; step <= PATH_ARC_SUBDIVISIONS_V1 && tangentIsZero(); step += 1) {
    const priorParameter = parameter * (1 - step / PATH_ARC_SUBDIVISIONS_V1);
    tangent = tangentOnCubic(selected.start, selected.segment, priorParameter);
  }
  for (let index = selectedIndex - 1; index >= 0 && tangentIsZero(); index -= 1) {
    for (let step = 0; step <= PATH_ARC_SUBDIVISIONS_V1 && tangentIsZero(); step += 1) {
      tangent = tangentOnCubic(entries[index].start, entries[index].segment, 1 - step / PATH_ARC_SUBDIVISIONS_V1);
    }
  }
  for (let step = 1; step <= PATH_ARC_SUBDIVISIONS_V1 && tangentIsZero(); step += 1) {
    const forwardParameter = parameter + (1 - parameter) * (step / PATH_ARC_SUBDIVISIONS_V1);
    tangent = tangentOnCubic(selected.start, selected.segment, forwardParameter);
  }
  for (let index = selectedIndex + 1; index < entries.length && tangentIsZero(); index += 1) {
    for (let step = 0; step <= PATH_ARC_SUBDIVISIONS_V1 && tangentIsZero(); step += 1) {
      tangent = tangentOnCubic(entries[index].start, entries[index].segment, step / PATH_ARC_SUBDIVISIONS_V1);
    }
  }
  return { point, tangent: tangentIsZero() ? null : tangent };
}

/** Mirrors VMobject.point_from_proportion for canonical two-dimensional cubics. */
export function sampleCubicPathManimPointFromProportionV1(path: CubicPathV1, progress: number) {
  const entries = serializedCubicEntriesBySubpath(path).flat();
  if (entries.length === 0) throw new EngineGeometryEvaluationError("A motion path requires at least one cubic.");
  if (progress >= 1) return entries.at(-1)!.segment.end;

  const lengths = entries.map((entry) => {
    let length = 0;
    let previous = entry.start;
    const sampleStep = 1 / (MANIM_CURVE_LENGTH_SAMPLE_POINTS_V1 - 1);
    for (let index = 1; index < MANIM_CURVE_LENGTH_SAMPLE_POINTS_V1; index += 1) {
      const point = pointOnCubicV1(entry.start, entry.segment, index * sampleStep);
      length += distance(previous, point);
      previous = point;
    }
    return length;
  });
  const target = Math.min(1, Math.max(0, progress)) * lengths.reduce((total, length) => total + length, 0);
  let current = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const length = lengths[index];
    if (current + length >= target) {
      const parameter = length === 0 ? 0 : (target - current) / length;
      return pointOnCubicV1(entry.start, entry.segment, parameter);
    }
    current += length;
  }
  return entries.at(-1)!.segment.end;
}

export function interpolateCubicPathV1(left: CubicPathV1, right: CubicPathV1, progress: number): CubicPathV1 {
  return {
    subpaths: left.subpaths.map((subpath, subpathIndex) => ({
      closed: subpath.closed,
      segments: subpath.segments.map((segment, segmentIndex) => {
        const target = right.subpaths[subpathIndex].segments[segmentIndex];
        return {
          control1: interpolatePoint(segment.control1, target.control1, progress),
          control2: interpolatePoint(segment.control2, target.control2, progress),
          end: interpolatePoint(segment.end, target.end, progress),
        };
      }),
      start: interpolatePoint(subpath.start, right.subpaths[subpathIndex].start, progress),
    })),
  };
}

function circlePath(center: EnginePointV1, radius: number): CubicPathV1 {
  const kappa = (4 * (Math.SQRT2 - 1)) / 3;
  const control = radius * kappa;
  const right = { x: center.x + radius, y: center.y };
  const top = { x: center.x, y: center.y + radius };
  const left = { x: center.x - radius, y: center.y };
  const bottom = { x: center.x, y: center.y - radius };
  return {
    subpaths: [
      {
        closed: true,
        segments: [
          { control1: { x: right.x, y: right.y + control }, control2: { x: top.x + control, y: top.y }, end: top },
          { control1: { x: top.x - control, y: top.y }, control2: { x: left.x, y: left.y + control }, end: left },
          {
            control1: { x: left.x, y: left.y - control },
            control2: { x: bottom.x - control, y: bottom.y },
            end: bottom,
          },
          {
            control1: { x: bottom.x + control, y: bottom.y },
            control2: { x: right.x, y: right.y - control },
            end: right,
          },
        ],
        start: right,
      },
    ],
  };
}

function rectanglePath(center: EnginePointV1, width: number, height: number, cornerRadius: number): CubicPathV1 {
  const left = center.x - width / 2;
  const right = center.x + width / 2;
  const bottom = center.y - height / 2;
  const top = center.y + height / 2;
  const radius = cornerRadius;
  const start = { x: right - radius, y: bottom };
  if (radius === 0) {
    const points = [{ x: left, y: bottom }, { x: left, y: top }, { x: right, y: top }, start];
    let prior = start;
    const segments = points.map((point) => {
      const segment = lineSegment(prior, point);
      prior = point;
      return segment;
    });
    return { subpaths: [{ closed: true, segments, start }] };
  }

  const control = radius * ((4 * (Math.SQRT2 - 1)) / 3);
  const segments: CubicSegmentV1[] = [];
  let prior = start;
  const lineTo = (end: EnginePointV1) => {
    segments.push(lineSegment(prior, end));
    prior = end;
  };
  const curveTo = (control1: EnginePointV1, control2: EnginePointV1, end: EnginePointV1) => {
    segments.push({ control1, control2, end });
    prior = end;
  };
  lineTo({ x: left + radius, y: bottom });
  curveTo(
    { x: left + radius - control, y: bottom },
    { x: left, y: bottom + radius - control },
    { x: left, y: bottom + radius },
  );
  lineTo({ x: left, y: top - radius });
  curveTo({ x: left, y: top - radius + control }, { x: left + radius - control, y: top }, { x: left + radius, y: top });
  lineTo({ x: right - radius, y: top });
  curveTo(
    { x: right - radius + control, y: top },
    { x: right, y: top - radius + control },
    { x: right, y: top - radius },
  );
  lineTo({ x: right, y: bottom + radius });
  curveTo({ x: right, y: bottom + radius - control }, { x: right - radius + control, y: bottom }, start);
  return { subpaths: [{ closed: true, segments, start }] };
}

export function sceneGeometryAsCubicPathV1(
  geometry: Exclude<SceneEntityGeometryV1, { kind: "group" | "image" }>,
): CubicPathV1 {
  if (geometry.kind === "cubic-path") return geometry.path;
  if (geometry.kind === "circle") return circlePath(geometry.center, geometry.radius);
  if (geometry.kind === "line")
    return {
      subpaths: [{ closed: false, segments: [lineSegment(geometry.start, geometry.end)], start: geometry.start }],
    };
  return rectanglePath(geometry.center, geometry.width, geometry.height, geometry.cornerRadius);
}

export function interpolateAffineTransformV1(
  left: EngineAffineTransformV1,
  right: EngineAffineTransformV1,
  progress: number,
): EngineAffineTransformV1 {
  return {
    m11: left.m11 + (right.m11 - left.m11) * progress,
    m12: left.m12 + (right.m12 - left.m12) * progress,
    m21: left.m21 + (right.m21 - left.m21) * progress,
    m22: left.m22 + (right.m22 - left.m22) * progress,
    tx: left.tx + (right.tx - left.tx) * progress,
    ty: left.ty + (right.ty - left.ty) * progress,
  };
}

export function composeAffineTransformsV1(
  outer: EngineAffineTransformV1,
  inner: EngineAffineTransformV1,
): EngineAffineTransformV1 {
  return {
    m11: outer.m11 * inner.m11 + outer.m12 * inner.m21,
    m12: outer.m11 * inner.m12 + outer.m12 * inner.m22,
    m21: outer.m21 * inner.m11 + outer.m22 * inner.m21,
    m22: outer.m21 * inner.m12 + outer.m22 * inner.m22,
    tx: outer.m11 * inner.tx + outer.m12 * inner.ty + outer.tx,
    ty: outer.m21 * inner.tx + outer.m22 * inner.ty + outer.ty,
  };
}

export function applyMotionPathV1(
  transform: EngineAffineTransformV1,
  path: CubicPathV1,
  progress: number,
  orientToPath: boolean,
): EngineAffineTransformV1 {
  const sample = sampleCubicPathV1(path, progress);
  if (!orientToPath) return { ...transform, tx: sample.point.x, ty: sample.point.y };
  if (sample.tangent === null) {
    throw new EngineGeometryEvaluationError("orientToPath requires a motion path with a non-zero tangent.");
  }
  const angle = Math.atan2(sample.tangent.y, sample.tangent.x);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    m11: cosine * transform.m11 - sine * transform.m21,
    m12: cosine * transform.m12 - sine * transform.m22,
    m21: sine * transform.m11 + cosine * transform.m21,
    m22: sine * transform.m12 + cosine * transform.m22,
    tx: sample.point.x,
    ty: sample.point.y,
  };
}

export function applyManimMotionPathV1(
  transform: EngineAffineTransformV1,
  path: CubicPathV1,
  progress: number,
): EngineAffineTransformV1 {
  const point = sampleCubicPathManimPointFromProportionV1(path, progress);
  return { ...transform, tx: point.x, ty: point.y };
}
