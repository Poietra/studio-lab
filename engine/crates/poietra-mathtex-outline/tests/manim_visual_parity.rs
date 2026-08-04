use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use poietra_mathtex_outline::{
    MathTexOutlineRequestV1, MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
    compile_mathtex_outline_v1,
};
use poietra_scene_ir::{CubicPathV1, PointV1};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const CORPUS_JSON: &str = include_str!("../../../../fixtures/mathtex-manim-parity-v1/corpus.json");
const EXPECTED_MANIM_IMAGE: &str =
    "manimcommunity/manim@sha256:f18f53f2e4eaf2ea41713437d34363fb3f5cc6008b03fd798676ac0359396c3b";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    schema: String,
    version: u32,
    reference_producer: ReferenceProducer,
    comparison: Comparison,
    cases: Vec<ParityCase>,
    semantic_exclusions: Vec<SemanticExclusionCase>,
    unsupported_cases: Vec<UnsupportedParityCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceProducer {
    kind: String,
    docker_image: String,
    manim_version: String,
    latex_version: String,
    dvisvgm_version: String,
    generation_command: String,
    licenses: Vec<LicenseMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LicenseMetadata {
    component: String,
    #[serde(rename = "license")]
    name: String,
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Comparison {
    kind: String,
    minimum_io_u: f64,
    maximum_aspect_ratio_relative_delta: f64,
    maximum_baseline_absolute_delta: f64,
    maximum_normalized_bounds_absolute_delta: f64,
    maximum_normalized_full_image_mean_absolute_error: f64,
    curve_steps: usize,
    raster_height_px: usize,
    raster_width_px: usize,
    samples_per_axis: usize,
    statement: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParityCase {
    id: String,
    tex_parts: Vec<String>,
    provenance: String,
    mask_rows: Vec<String>,
    mask_sha256: String,
    normalized_bounds: Bounds,
    svg_file: String,
    svg_sha256: String,
    svg_view_box: SvgViewBox,
    viewport: Bounds,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnsupportedParityCase {
    id: String,
    tex_parts: Vec<String>,
    expected_failure: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SemanticExclusionCase {
    id: String,
    tex_parts: Vec<String>,
    reference_tex_parts: Vec<String>,
    expected_relation: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Bounds {
    bottom: f64,
    left: f64,
    right: f64,
    top: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SvgViewBox {
    baseline_y: f64,
    height: f64,
    minimum_x: f64,
    minimum_y: f64,
    width: f64,
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/mathtex-manim-parity-v1")
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn usize_to_f64(value: usize) -> f64 {
    f64::from(u32::try_from(value).expect("visual fixture dimensions are bounded"))
}

fn decode_mask(case: &ParityCase, comparison: &Comparison) -> Vec<u8> {
    assert_eq!(case.mask_rows.len(), comparison.raster_height_px);
    let maximum_coverage = comparison.samples_per_axis * comparison.samples_per_axis;
    let mut mask = Vec::with_capacity(comparison.raster_width_px * comparison.raster_height_px);
    for row in &case.mask_rows {
        assert_eq!(row.len(), comparison.raster_width_px);
        for byte in row.bytes() {
            let coverage = char::from(byte)
                .to_digit(16)
                .expect("coverage mask must contain hexadecimal digits")
                as usize;
            assert!(coverage <= maximum_coverage);
            mask.push(u8::try_from(coverage).expect("coverage is bounded"));
        }
    }
    assert_eq!(sha256(&mask), case.mask_sha256);
    mask
}

fn cubic_point(
    start: &PointV1,
    control1: &PointV1,
    control2: &PointV1,
    end: &PointV1,
    time: f64,
) -> Point {
    let inverse = 1.0 - time;
    let weights = [
        inverse * inverse * inverse,
        3.0 * inverse * inverse * time,
        3.0 * inverse * time * time,
        time * time * time,
    ];
    Point {
        x: weights[0] * start.x
            + weights[1] * control1.x
            + weights[2] * control2.x
            + weights[3] * end.x,
        y: weights[0] * start.y
            + weights[1] * control1.y
            + weights[2] * control2.y
            + weights[3] * end.y,
    }
}

fn flatten_path(path: &CubicPathV1, curve_steps: usize) -> Vec<Vec<Point>> {
    path.subpaths
        .iter()
        .map(|subpath| {
            let mut points = Vec::with_capacity(subpath.segments.len() * curve_steps + 2);
            points.push(Point {
                x: subpath.start.x,
                y: subpath.start.y,
            });
            let mut start = &subpath.start;
            for segment in &subpath.segments {
                for step in 1..=curve_steps {
                    points.push(cubic_point(
                        start,
                        &segment.control1,
                        &segment.control2,
                        &segment.end,
                        usize_to_f64(step) / usize_to_f64(curve_steps),
                    ));
                }
                start = &segment.end;
            }
            if subpath.closed {
                points.push(points[0]);
            }
            points
        })
        .collect()
}

fn rasterize(
    path: &CubicPathV1,
    viewport: Bounds,
    width: usize,
    height: usize,
    samples_per_axis: usize,
    curve_steps: usize,
) -> Vec<u8> {
    let contours = flatten_path(path, curve_steps);
    let sample_width = width * samples_per_axis;
    let sample_height = height * samples_per_axis;
    let mut samples = vec![false; sample_width * sample_height];

    for sample_y in 0..sample_height {
        let y = viewport.top
            - (usize_to_f64(sample_y) + 0.5) / usize_to_f64(sample_height)
                * (viewport.top - viewport.bottom);
        let mut crossings = Vec::new();
        for contour in &contours {
            for edge in contour.windows(2) {
                let [start, end] = edge else {
                    unreachable!("windows(2) always returns two points");
                };
                let winding_delta = if start.y <= y && y < end.y {
                    1_i32
                } else if end.y <= y && y < start.y {
                    -1_i32
                } else {
                    continue;
                };
                let x = start.x + (y - start.y) * (end.x - start.x) / (end.y - start.y);
                crossings.push((x, winding_delta));
            }
        }
        crossings.sort_by(|left, right| left.0.total_cmp(&right.0));

        let mut crossing_index = 0;
        let mut winding = 0_i32;
        for sample_x in 0..sample_width {
            let x = viewport.left
                + (usize_to_f64(sample_x) + 0.5) / usize_to_f64(sample_width)
                    * (viewport.right - viewport.left);
            while crossing_index < crossings.len() && crossings[crossing_index].0 <= x {
                winding += crossings[crossing_index].1;
                crossing_index += 1;
            }
            samples[sample_y * sample_width + sample_x] = winding != 0;
        }
    }

    let mut coverage = vec![0_u8; width * height];
    for pixel_y in 0..height {
        for pixel_x in 0..width {
            let mut covered = 0_u8;
            for offset_y in 0..samples_per_axis {
                for offset_x in 0..samples_per_axis {
                    let sample_y = pixel_y * samples_per_axis + offset_y;
                    let sample_x = pixel_x * samples_per_axis + offset_x;
                    covered += u8::from(samples[sample_y * sample_width + sample_x]);
                }
            }
            coverage[pixel_y * width + pixel_x] = covered;
        }
    }
    coverage
}

fn soft_intersection_over_union(left: &[u8], right: &[u8]) -> f64 {
    assert_eq!(left.len(), right.len());
    let intersection = left
        .iter()
        .zip(right)
        .map(|(left, right)| f64::from((*left).min(*right)))
        .sum::<f64>();
    let union = left
        .iter()
        .zip(right)
        .map(|(left, right)| f64::from((*left).max(*right)))
        .sum::<f64>();
    assert!(union > 0.0, "visual parity masks must contain ink");
    intersection / union
}

fn normalized_full_image_mean_absolute_error(
    left: &[u8],
    right: &[u8],
    maximum_coverage: usize,
) -> f64 {
    assert_eq!(left.len(), right.len());
    assert!(!left.is_empty());
    assert!(maximum_coverage > 0);
    let absolute_error = left
        .iter()
        .zip(right)
        .map(|(left, right)| f64::from(left.abs_diff(*right)))
        .sum::<f64>();
    absolute_error / (usize_to_f64(left.len()) * usize_to_f64(maximum_coverage))
}

fn maximum_bounds_absolute_delta(left: Bounds, right: Bounds) -> f64 {
    [
        (left.left - right.left).abs(),
        (left.right - right.right).abs(),
        (left.bottom - right.bottom).abs(),
        (left.top - right.top).abs(),
    ]
    .into_iter()
    .fold(0.0, f64::max)
}

fn assert_finite_bounds(bounds: Bounds) {
    assert!(
        [bounds.left, bounds.right, bounds.bottom, bounds.top]
            .into_iter()
            .all(f64::is_finite)
    );
    assert!(bounds.left < bounds.right);
    assert!(bounds.bottom < bounds.top);
}

fn assert_ratex_metrics(case: &ParityCase, comparison: &Comparison) {
    let reference = decode_mask(case, comparison);
    let result = compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(case.tex_parts.clone()));
    let MathTexOutlineResultV1::Compiled(artifact) = result else {
        panic!("{} must compile for real-Manim parity", case.id);
    };
    let actual = rasterize(
        &artifact.path,
        case.viewport,
        comparison.raster_width_px,
        comparison.raster_height_px,
        comparison.samples_per_axis,
        comparison.curve_steps,
    );
    let intersection_over_union = soft_intersection_over_union(&actual, &reference);
    let full_image_mean_absolute_error = normalized_full_image_mean_absolute_error(
        &actual,
        &reference,
        comparison.samples_per_axis * comparison.samples_per_axis,
    );
    let bounds_delta = maximum_bounds_absolute_delta(
        Bounds {
            bottom: artifact.bounds.bottom,
            left: artifact.bounds.left,
            right: artifact.bounds.right,
            top: artifact.bounds.top,
        },
        case.normalized_bounds,
    );
    let reference_aspect = (case.normalized_bounds.right - case.normalized_bounds.left)
        / (case.normalized_bounds.top - case.normalized_bounds.bottom);
    let actual_aspect = (artifact.bounds.right - artifact.bounds.left)
        / (artifact.bounds.top - artifact.bounds.bottom);
    let aspect_delta = (actual_aspect - reference_aspect).abs() / reference_aspect;
    println!(
        "{}: Manim IoU={intersection_over_union:.4}, aspect delta={aspect_delta:.4}, bounds delta={bounds_delta:.4}, full-image MAE={full_image_mean_absolute_error:.4}",
        case.id
    );
    assert!(
        intersection_over_union >= comparison.minimum_io_u,
        "{}: RaTeX/Manim IoU {intersection_over_union:.4} is below {:.4}",
        case.id,
        comparison.minimum_io_u
    );
    assert!(
        aspect_delta <= comparison.maximum_aspect_ratio_relative_delta,
        "{}: RaTeX/Manim aspect delta {aspect_delta:.4} exceeds {:.4}",
        case.id,
        comparison.maximum_aspect_ratio_relative_delta
    );
    assert!(
        bounds_delta <= comparison.maximum_normalized_bounds_absolute_delta,
        "{}: RaTeX/Manim normalized bounds delta {bounds_delta:.4} exceeds {:.4}",
        case.id,
        comparison.maximum_normalized_bounds_absolute_delta
    );
    assert!(
        full_image_mean_absolute_error
            <= comparison.maximum_normalized_full_image_mean_absolute_error,
        "{}: RaTeX/Manim normalized full-image MAE {full_image_mean_absolute_error:.4} exceeds {:.4}",
        case.id,
        comparison.maximum_normalized_full_image_mean_absolute_error
    );
}

fn assert_source_profile_exclusions(corpus: &Corpus) {
    assert_eq!(corpus.semantic_exclusions.len(), 1);
    assert_eq!(corpus.unsupported_cases.len(), 44);

    for case in &corpus.semantic_exclusions {
        assert!(!case.id.is_empty());
        assert!(!case.reference_tex_parts.is_empty());
        assert_eq!(case.expected_relation, "normalized-outline-identical");
        assert!(matches!(
            compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(
                case.reference_tex_parts.clone()
            )),
            MathTexOutlineResultV1::Compiled(_)
        ));
        let result =
            compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(case.tex_parts.clone()));
        let MathTexOutlineResultV1::Unsupported(unsupported) = result else {
            panic!(
                "source with divergent RaTeX semantics bypassed the profile: {}",
                case.id
            );
        };
        assert_eq!(
            unsupported.code,
            MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
            "{}",
            case.id
        );
    }

    for case in &corpus.unsupported_cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.expected_failure, "latex-compile-error");
        let result =
            compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(case.tex_parts.clone()));
        let MathTexOutlineResultV1::Unsupported(unsupported) = result else {
            panic!(
                "RaTeX-only source compiled despite pinned Manim failure: {}",
                case.id
            );
        };
        assert_eq!(
            unsupported.code,
            MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
            "{}",
            case.id
        );
    }
}

#[test]
fn ratex_outlines_match_pinned_real_manim_svg_references() {
    let corpus: Corpus = serde_json::from_str(CORPUS_JSON).expect("parity corpus must deserialize");
    assert_eq!(corpus.schema, "poietra.mathtex-manim-visual-parity");
    assert_eq!(corpus.version, 1);
    assert_eq!(corpus.reference_producer.kind, "manim-mathtex-svg");
    assert_eq!(corpus.reference_producer.docker_image, EXPECTED_MANIM_IMAGE);
    assert_eq!(corpus.reference_producer.manim_version, "0.20.1");
    assert!(!corpus.reference_producer.latex_version.is_empty());
    assert!(!corpus.reference_producer.dvisvgm_version.is_empty());
    assert_eq!(
        corpus.reference_producer.generation_command,
        "node scripts/regenerate-mathtex-manim-parity.mjs"
    );
    assert_eq!(corpus.reference_producer.licenses.len(), 4);
    for license in &corpus.reference_producer.licenses {
        assert!(!license.component.is_empty());
        assert!(!license.name.is_empty());
        assert!(license.source.starts_with("https://"));
    }
    assert_eq!(corpus.comparison.kind, "normalized-filled-outline");
    assert!(
        corpus
            .comparison
            .statement
            .contains("not a RaTeX-to-KaTeX self-comparison")
    );
    assert_eq!(corpus.comparison.raster_width_px, 192);
    assert_eq!(corpus.comparison.raster_height_px, 64);
    assert_eq!(corpus.comparison.samples_per_axis, 2);
    assert!((1..=32).contains(&corpus.comparison.curve_steps));
    assert!(
        (0.0..=1.0).contains(
            &corpus
                .comparison
                .maximum_normalized_full_image_mean_absolute_error
        )
    );
    assert!(
        corpus
            .comparison
            .maximum_baseline_absolute_delta
            .is_finite()
    );
    assert!(corpus.comparison.maximum_baseline_absolute_delta >= 0.0);
    assert!(corpus.comparison.maximum_normalized_bounds_absolute_delta >= 0.0);
    assert_eq!(corpus.cases.len(), 3);
    assert_source_profile_exclusions(&corpus);

    let root = fixture_root();
    for case in &corpus.cases {
        assert!(!case.provenance.is_empty());
        assert_finite_bounds(case.normalized_bounds);
        assert_finite_bounds(case.viewport);
        assert!(case.svg_view_box.width.is_finite() && case.svg_view_box.width > 0.0);
        assert!(case.svg_view_box.height.is_finite() && case.svg_view_box.height > 0.0);
        assert!(case.svg_view_box.minimum_x.is_finite());
        assert!(case.svg_view_box.minimum_y.is_finite());
        assert!(case.svg_view_box.baseline_y.is_finite());

        let relative_svg = Path::new(&case.svg_file);
        assert!(relative_svg.starts_with("references"));
        assert!(
            relative_svg
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        );
        let svg = fs::read(root.join(relative_svg)).expect("checked-in Manim SVG must exist");
        assert_eq!(sha256(&svg), case.svg_sha256);
        assert!(svg.windows(4).any(|window| window == b"<svg"));

        assert_ratex_metrics(case, &corpus.comparison);
    }
}
