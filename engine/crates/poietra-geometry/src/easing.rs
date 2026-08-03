use poietra_scene_ir::EasingV1;

const NEWTON_ITERATIONS: usize = 8;
const BISECTION_ITERATIONS: usize = 24;
const SOLVER_TOLERANCE: f64 = 1.0e-7;
const MANIM_SMOOTH_INFLECTION: f64 = 10.0;

fn manim_smooth(progress: f64) -> f64 {
    if progress <= 0.0 {
        return 0.0;
    }
    if progress >= 1.0 {
        return 1.0;
    }
    let error = 1.0 / (1.0 + (MANIM_SMOOTH_INFLECTION / 2.0).exp());
    let sigmoid = 1.0 / (1.0 + (-MANIM_SMOOTH_INFLECTION * (progress - 0.5)).exp());
    ((sigmoid - error) / (1.0 - 2.0 * error)).clamp(0.0, 1.0)
}

fn cubic_coordinate(control1: f64, control2: f64, parameter: f64) -> f64 {
    let inverse = 1.0 - parameter;
    3.0 * inverse * inverse * parameter * control1
        + 3.0 * inverse * parameter * parameter * control2
        + parameter.powi(3)
}

fn cubic_derivative(control1: f64, control2: f64, parameter: f64) -> f64 {
    let inverse = 1.0 - parameter;
    3.0 * inverse * inverse * control1
        + 6.0 * inverse * parameter * (control2 - control1)
        + 3.0 * parameter * parameter * (1.0 - control2)
}

fn solve_bezier_parameter(x1: f64, x2: f64, target: f64) -> f64 {
    let mut parameter = target;
    for _ in 0..NEWTON_ITERATIONS {
        let error = cubic_coordinate(x1, x2, parameter) - target;
        if error.abs() <= SOLVER_TOLERANCE {
            return parameter;
        }
        let derivative = cubic_derivative(x1, x2, parameter);
        if derivative.abs() <= SOLVER_TOLERANCE {
            break;
        }
        let next = parameter - error / derivative;
        if !(0.0..=1.0).contains(&next) {
            break;
        }
        parameter = next;
    }

    let mut lower = 0.0;
    let mut upper = 1.0;
    for _ in 0..BISECTION_ITERATIONS {
        parameter = f64::midpoint(lower, upper);
        let value = cubic_coordinate(x1, x2, parameter);
        if (value - target).abs() <= SOLVER_TOLERANCE {
            break;
        }
        if value < target {
            lower = parameter;
        } else {
            upper = parameter;
        }
    }
    parameter
}

/// Applies the deterministic v1 timing function to a normalized progress value.
///
/// Progress is clamped to `[0, 1]`, matching the TypeScript reference evaluator.
pub fn apply_easing_v1(easing: &EasingV1, progress: f64) -> f64 {
    let bounded = progress.clamp(0.0, 1.0);
    match easing {
        EasingV1::Linear {} => bounded,
        EasingV1::Smooth {} => bounded * bounded * (3.0 - 2.0 * bounded),
        EasingV1::ManimSmooth {} => manim_smooth(bounded),
        EasingV1::CubicBezier { x1, x2, y1, y2 } => {
            let parameter = solve_bezier_parameter(*x1, *x2, bounded);
            cubic_coordinate(*y1, *y2, parameter)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ManimSmoothFixture {
        reference: ManimSmoothReference,
        samples: Vec<ManimSmoothSample>,
        tolerance: f64,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ManimSmoothReference {
        inflection: f64,
        manim_version: String,
        symbol: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ManimSmoothSample {
        progress: f64,
        value: f64,
    }

    #[test]
    fn smooth_has_fixed_endpoints_and_midpoint() {
        assert!(apply_easing_v1(&EasingV1::Smooth {}, -1.0).abs() < f64::EPSILON);
        assert!((apply_easing_v1(&EasingV1::Smooth {}, 0.5) - 0.5).abs() < f64::EPSILON);
        assert!((apply_easing_v1(&EasingV1::Smooth {}, 2.0) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn manim_smooth_matches_fixed_python_reference_samples() {
        let fixture: ManimSmoothFixture = serde_json::from_str(include_str!(
            "../../../../fixtures/engine-v1/manim-smooth-easing.json"
        ))
        .unwrap();
        assert!((fixture.reference.inflection - 10.0).abs() < f64::EPSILON);
        assert_eq!(fixture.reference.manim_version, "0.20.1");
        assert_eq!(
            fixture.reference.symbol,
            "manim.utils.rate_functions.smooth"
        );
        for sample in fixture.samples {
            let actual = apply_easing_v1(&EasingV1::ManimSmooth {}, sample.progress);
            assert!(
                (actual - sample.value).abs() <= fixture.tolerance,
                "progress={}: expected {}, received {actual}",
                sample.progress,
                sample.value
            );
        }
    }

    #[test]
    fn cubic_bezier_solves_x_before_sampling_y() {
        let easing = EasingV1::CubicBezier {
            x1: 0.42,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        };
        let sample = apply_easing_v1(&easing, 0.5);
        assert!((sample - 0.315_356_8).abs() < 1.0e-6, "sample={sample}");
    }
}
