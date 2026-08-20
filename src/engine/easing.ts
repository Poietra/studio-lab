import type { SceneEasingV1 } from "./scene-ir";

export type EngineEasingV1 = SceneEasingV1;

const NEWTON_ITERATIONS = 8;
const BISECTION_ITERATIONS = 24;
const SOLVER_TOLERANCE = 1e-7;
const MANIM_SMOOTH_INFLECTION = 10;
const MANIM_SMOOTH_ERROR = 1 / (1 + Math.exp(MANIM_SMOOTH_INFLECTION / 2));

function manimSmooth(progress: number) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const sigmoid = 1 / (1 + Math.exp(-MANIM_SMOOTH_INFLECTION * (progress - 0.5)));
  return Math.min(1, Math.max(0, (sigmoid - MANIM_SMOOTH_ERROR) / (1 - 2 * MANIM_SMOOTH_ERROR)));
}

function cubicCoordinate(control1: number, control2: number, parameter: number) {
  const inverse = 1 - parameter;
  return 3 * inverse * inverse * parameter * control1 + 3 * inverse * parameter * parameter * control2 + parameter ** 3;
}

function cubicDerivative(control1: number, control2: number, parameter: number) {
  const inverse = 1 - parameter;
  return (
    3 * inverse * inverse * control1 +
    6 * inverse * parameter * (control2 - control1) +
    3 * parameter * parameter * (1 - control2)
  );
}

function solveBezierParameter(x1: number, x2: number, target: number) {
  let parameter = target;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const error = cubicCoordinate(x1, x2, parameter) - target;
    if (Math.abs(error) <= SOLVER_TOLERANCE) return parameter;
    const derivative = cubicDerivative(x1, x2, parameter);
    if (Math.abs(derivative) <= SOLVER_TOLERANCE) break;
    const next = parameter - error / derivative;
    if (next < 0 || next > 1) break;
    parameter = next;
  }

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    parameter = (lower + upper) / 2;
    const value = cubicCoordinate(x1, x2, parameter);
    if (Math.abs(value - target) <= SOLVER_TOLERANCE) break;
    if (value < target) lower = parameter;
    else upper = parameter;
  }
  return parameter;
}

export function applyEngineEasingV1(easing: EngineEasingV1, progress: number) {
  const bounded = Math.min(1, Math.max(0, progress));
  if (easing.kind === "linear") return bounded;
  if (easing.kind === "smooth") return bounded * bounded * (3 - 2 * bounded);
  if (easing.kind === "manim-smooth") return manimSmooth(bounded);
  const parameter = solveBezierParameter(easing.x1, easing.x2, bounded);
  return cubicCoordinate(easing.y1, easing.y2, parameter);
}
