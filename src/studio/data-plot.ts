import type { DataSeries, EntityDimensions, Point } from "./model";

export const MAX_DATA_PLOT_POINTS = 256;

function dataPlotCoordinateSystem(dimensions: EntityDimensions) {
  const coordinateSystem = dimensions.coordinateSystem;
  if (
    !coordinateSystem?.y ||
    dimensions.width === undefined ||
    dimensions.height === undefined ||
    dimensions.angles !== undefined ||
    dimensions.radius !== undefined ||
    dimensions.sides !== undefined
  ) {
    return null;
  }
  const axes = [coordinateSystem.x, coordinateSystem.y];
  return axes.every(
    (axis) =>
      Number.isFinite(axis.minimum) &&
      Number.isFinite(axis.maximum) &&
      Number.isFinite(axis.step) &&
      axis.minimum < axis.maximum &&
      axis.step > 0,
  ) &&
    Number.isFinite(dimensions.width) &&
    dimensions.width > 0 &&
    Number.isFinite(dimensions.height) &&
    dimensions.height > 0
    ? coordinateSystem
    : null;
}

/** Mirrors Rust admission without deriving or interpolating render geometry. */
export function dataSeriesUnavailableReason(dataSeries: DataSeries, dimensions: EntityDimensions): string | null {
  const coordinateSystem = dataPlotCoordinateSystem(dimensions);
  if (!coordinateSystem) return "Data plots require an exact two-dimensional Axes range and size.";
  const yRange = coordinateSystem.y;
  if (!yRange) return "Data plots require an exact two-dimensional Axes range and size.";
  if (dataSeries.interpolation !== "linear" && dataSeries.interpolation !== "smooth") {
    return "Choose Linear or Smooth interpolation.";
  }
  if (dataSeries.points.length < 2 || dataSeries.points.length > MAX_DATA_PLOT_POINTS) {
    return `Enter 2 to ${MAX_DATA_PLOT_POINTS} data points.`;
  }
  for (let index = 0; index < dataSeries.points.length; index += 1) {
    const point = dataSeries.points[index];
    const previous = dataSeries.points[index - 1];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return `Data point ${index + 1} must contain finite x and y values.`;
    }
    if (previous && point.x <= previous.x) return "Data point x values must be strictly increasing.";
    if (
      point.x < coordinateSystem.x.minimum ||
      point.x > coordinateSystem.x.maximum ||
      point.y < yRange.minimum ||
      point.y > yRange.maximum
    ) {
      return `Data point ${index + 1} must stay inside the selected Axes range.`;
    }
  }
  return null;
}

export type ParsedDataPlotCsv =
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "valid"; points: readonly Point[] }>;

export function parseDataPlotCsv(value: string): ParsedDataPlotCsv {
  const rows = value
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length < 2 || rows.length > MAX_DATA_PLOT_POINTS) {
    return { kind: "invalid", message: `Enter 2 to ${MAX_DATA_PLOT_POINTS} x,y rows.` };
  }
  const points: Point[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = rows[index]?.split(",").map((cell) => cell.trim()) ?? [];
    if (cells.length !== 2 || cells.some((cell) => cell.length === 0)) {
      return { kind: "invalid", message: `Row ${index + 1} must use the format x,y.` };
    }
    const x = Number(cells[0]);
    const y = Number(cells[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { kind: "invalid", message: `Row ${index + 1} must contain finite numbers.` };
    }
    points.push({ x, y });
  }
  return { kind: "valid", points };
}

export function formatDataPlotCsv(points: readonly Point[]) {
  return points.map(({ x, y }) => `${x},${y}`).join("\n");
}
