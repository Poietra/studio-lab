export type EngineEasingV1 =
  | Readonly<{ kind: "linear" }>
  | Readonly<{ kind: "smooth" }>
  | Readonly<{ kind: "cubic-bezier"; x1: number; x2: number; y1: number; y2: number }>;

const NEWTON_ITERATIONS = 8;
const BISECTION_ITERATIONS = 24;
const SOLVER_TOLERANCE = 1e-7;

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
  const parameter = solveBezierParameter(easing.x1, easing.x2, bounded);
  return cubicCoordinate(easing.y1, easing.y2, parameter);
}
