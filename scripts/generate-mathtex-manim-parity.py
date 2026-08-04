"""Generate pinned real-Manim SVG and normalized cubic reference fixtures.

Run through ``node scripts/regenerate-mathtex-manim-parity.mjs``. The wrapper
pins the OCI image, disables networking, and writes into a temporary directory
before replacing the checked-in fixture.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

import cairo
import manim
from manim import MathTex, config

CASES = (
    {
        "id": "mass-energy",
        "texParts": ["E = mc^2"],
        "provenance": "fixtures/real-preview-harness/scene_mathtex.py",
    },
    {
        "id": "nested-radical-fraction",
        "texParts": [r"\frac{1}{a+b\sqrt{2}}"],
        "provenance": "fast-manim/manim/mobject/text/tex_mobject.py:274",
    },
    {
        "id": "basel-sum",
        "texParts": [r"\sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}"],
        "provenance": "fast-manim/example_scenes/basic.py:21",
    },
)

# Compile-only evidence for the browser source profile. Keep this deliberately
# separate from CASES: only the three representative visual references above
# carry checked-in SVG/mask goldens. Every entry here must compile with the
# pinned image's runtime config.tex_template before its tokens may enter the
# RaTeX-backed browser profile.
SOURCE_PROFILE_CASES = (
    {
        "id": "greek-lowercase-core",
        "texParts": [
            r"\alpha+\beta+\gamma+\delta+\varepsilon+\theta+\lambda+\mu+\rho+\sigma+\tau+\phi+\psi+\omega"
        ],
    },
    {
        "id": "greek-uppercase-core",
        "texParts": [
            r"\Gamma+\Delta+\Theta+\Lambda+\Sigma+\Phi+\Psi+\Omega"
        ],
    },
    {
        "id": "calculus-and-large-operators",
        "texParts": [
            r"\lim_{x\to0}\frac{\sin x}{x}=1,\quad \int_0^\infty e^{-x}\,dx=1,\quad \sum_{n=1}^\infty\frac{1}{n^2},\quad \prod_{k=1}^n k,\quad \oint_\gamma f(z)\,dz"
        ],
    },
    {
        "id": "vector-fields-and-accents",
        "texParts": [
            r"\nabla\cdot\mathbf{E}=\frac{\rho}{\varepsilon_0},\quad \nabla\times\mathbf{B}=\mu_0\frac{\partial\mathbf{E}}{\partial t},\quad \hat{x}+\vec{v}+90^{\circ}"
        ],
    },
    {
        "id": "core-fonts-and-named-operator",
        "texParts": [
            r"\mathbb{R}\subseteq\mathrm{dom}(A),\quad \operatorname{rank}(A)+\operatorname*{arg\,max}_x f(x)+\textbf{bold}+\text{ text}"
        ],
    },
    {
        "id": "sets-relations-and-logic",
        "texParts": [
            r"\forall x\in A\cup B,\;\exists y\notin A\cap B:\;x\neq y\Rightarrow x\leq y\Leftrightarrow y\geq x,\quad x\approx y,\quad x\mapsto y"
        ],
    },
    {
        "id": "trigonometric-and-log-operators",
        "texParts": [r"\sin x+\cos x+\log x+\ln x"],
    },
    {
        "id": "fractions-radicals-over-and-delimiters",
        "texParts": [
            r"\left\{\frac{a}{b}+\sqrt{x}+{1\over n}\right\}+\left(x\right)+\left[x\right]"
        ],
    },
    {
        "id": "safe-control-symbol-escapes",
        "texParts": [r"\#\;\%\;\$\;\_\;\&\;\{\}"],
    },
    {
        "id": "array-inner-environment",
        "texParts": [r"\begin{array}{cc}a&b\\c&d\end{array}"],
    },
    {
        "id": "matrix-inner-environment",
        "texParts": [r"\begin{matrix}a&b\\c&d\end{matrix}"],
    },
    {
        "id": "bmatrix-inner-environment",
        "texParts": [r"\begin{bmatrix}a&b\\c&d\end{bmatrix}"],
    },
    {
        "id": "pmatrix-inner-environment",
        "texParts": [r"\begin{pmatrix}a&b\\c&d\end{pmatrix}"],
    },
    {
        "id": "cases-inner-environment",
        "texParts": [
            r"|x|=\begin{cases}x&\text{if }x\geq0\\-x&\text{if }x<0\end{cases}"
        ],
    },
    {
        "id": "aligned-inner-environment",
        "texParts": [
            r"\begin{aligned}x&=a+b\\y&=c+d\end{aligned}"
        ],
    },
)

# RaTeX intentionally supports these KaTeX/package commands, while Manim's
# pinned default template does not. The generator must observe a real LaTeX
# compile failure before the browser compiler may claim a structured fallback.
UNSUPPORTED_CASES = (
    {"id": "hat-control-symbol-argument", "texParts": [r"\hat\\"]},
    {"id": "hat-braced-line-break-argument", "texParts": [r"\hat{\\}"]},
    {"id": "vec-control-symbol-argument", "texParts": [r"\vec\\"]},
    {"id": "vec-braced-line-break-argument", "texParts": [r"\vec{\\}"]},
    {"id": "radical-closing-brace-argument", "texParts": [r"\sqrt}"]},
    {
        "id": "radical-environment-argument",
        "texParts": [r"\sqrt\begin{matrix}x\end{matrix}"],
    },
    {"id": "radical-alignment-argument", "texParts": [r"\sqrt&"]},
    {"id": "radical-braced-line-break-argument", "texParts": [r"\sqrt{\\}"]},
    {"id": "left-invalid-delimiter", "texParts": [r"\left x \right)"]},
    {"id": "right-invalid-delimiter", "texParts": [r"\left( x \right y"]},
    {"id": "sized-delimiter-bare-line-break", "texParts": [r"\left(x\\y\right)"]},
    {
        "id": "matrix-local-sized-delimiter-line-break",
        "texParts": [r"\begin{matrix}\left(x\\y\right)\end{matrix}"],
    },
    {
        "id": "array-local-sized-delimiter-line-break",
        "texParts": [r"\begin{array}{c}\left(x\\y\right)\end{array}"],
    },
    {
        "id": "text-environment-argument",
        "texParts": [r"\text{\begin{matrix}x\end{matrix}}"],
    },
    {
        "id": "text-environment-line-break-argument",
        "texParts": [r"\text{\begin{matrix}x\\y\end{matrix}}"],
    },
    {
        "id": "textbf-environment-argument",
        "texParts": [r"\textbf{\begin{matrix}x\end{matrix}}"],
    },
    {
        "id": "textbf-environment-line-break-argument",
        "texParts": [r"\textbf{\begin{matrix}x\\y\end{matrix}}"],
    },
    {"id": "fraction-line-break-numerator", "texParts": [r"\frac{\\}{b}"]},
    {"id": "fraction-line-break-denominator", "texParts": [r"\frac{a}{\\}"]},
    {"id": "superscript-closing-brace", "texParts": [r"x^}"]},
    {"id": "subscript-closing-brace", "texParts": [r"x_}"]},
    {"id": "superscript-alignment", "texParts": [r"x^&"]},
    {"id": "subscript-alignment", "texParts": [r"x_&"]},
    {
        "id": "superscript-environment",
        "texParts": [r"x^\begin{matrix}x\end{matrix}"],
    },
    {
        "id": "subscript-environment",
        "texParts": [r"x_\begin{matrix}x\end{matrix}"],
    },
    {
        "id": "superscript-environment-line-break",
        "texParts": [r"x^\begin{matrix}x\\y\end{matrix}"],
    },
    {
        "id": "subscript-environment-line-break",
        "texParts": [r"x_\begin{matrix}x\\y\end{matrix}"],
    },
    {"id": "katex-html", "texParts": [r"\htmlStyle{font-size:2em}{x}"]},
    {"id": "hyperref-href", "texParts": [r"\href{https://example.test}{x}"]},
    {"id": "hyperref-url", "texParts": [r"\url{https://example.test}"]},
    {"id": "mhchem", "texParts": [r"\ce{H2O}"]},
    {"id": "color", "texParts": [r"\color{red}{x}"]},
    {"id": "textcolor", "texParts": [r"\textcolor{red}{x}"]},
    {"id": "raw-unicode-alpha", "texParts": ["α"]},
    {"id": "raw-unicode-sum", "texParts": ["∑"]},
    {"id": "raw-unicode-radical", "texParts": ["√x"]},
    {"id": "raw-unicode-accent", "texParts": ["é"]},
    {"id": "raw-unicode-blackboard", "texParts": ["ℝ"]},
    {"id": "raw-parameter-marker", "texParts": ["x#y"]},
    {"id": "raw-comment-marker", "texParts": ["x%y"]},
    {"id": "raw-math-delimiter", "texParts": ["$x$"]},
    {
        "id": "array-colon-separator",
        "texParts": [r"\begin{array}{c:c}a&b\end{array}"],
    },
    {"id": "array-colon-only", "texParts": [r"\begin{array}{:}a\end{array}"]},
    {"id": "line-break-math-unit", "texParts": [r"a\\[1mu]b"]},
)

# These inputs compile in pinned Manim, but RaTeX assigns different semantics.
# The generator proves the stated Manim relation before the source profile may
# exclude the candidate from truthful browser preview.
SEMANTIC_EXCLUSIONS = (
    {
        "id": "line-break-no-page-break-star",
        "texParts": [r"a\\*b"],
        "referenceTexParts": [r"a\\b"],
    },
)

# A zero-layout-size rule whose SVG rectangle identifies the TeX baseline.
# The dimensions are deliberately uncommon and the marker is compiled only in
# a second evidence object, never in the checked-in outline reference itself.
BASELINE_MARKER = r"\smash{\rlap{\rule{0.123pt}{0.01pt}}}"
TEX_POINT_TO_BIG_POINT = 72.0 / 72.27
BASELINE_MARKER_WIDTH_BP = 0.123 * TEX_POINT_TO_BIG_POINT
BASELINE_MARKER_HEIGHT_BP = 0.01 * TEX_POINT_TO_BIG_POINT


def command_version(command: str) -> str:
    output = subprocess.run(
        [command, "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return output.splitlines()[0].strip()


def runtime_tex_template_digest() -> str:
    sentinel = "POIETRA_MATHTEX_SOURCE_PROFILE_SENTINEL"
    source = config.tex_template.get_texcode_for_expression(sentinel)
    if source.count(sentinel) != 1:
        raise ValueError("runtime config.tex_template did not preserve the sentinel")
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def cubic_value(points: list[float], time: float) -> float:
    inverse = 1.0 - time
    return (
        inverse**3 * points[0]
        + 3.0 * inverse**2 * time * points[1]
        + 3.0 * inverse * time**2 * points[2]
        + time**3 * points[3]
    )


def cubic_extrema(points: list[float]) -> Iterable[float]:
    a = -points[0] + 3.0 * points[1] - 3.0 * points[2] + points[3]
    b = 3.0 * points[0] - 6.0 * points[1] + 3.0 * points[2]
    c = -3.0 * points[0] + 3.0 * points[1]
    discriminant = 4.0 * b * b - 12.0 * a * c
    if abs(a) <= 1.0e-14:
        if abs(b) > 1.0e-14:
            root = -c / (2.0 * b)
            if 0.0 < root < 1.0:
                yield root
        return
    if discriminant < 0.0:
        return
    root_discriminant = math.sqrt(discriminant)
    for root in (
        (-2.0 * b - root_discriminant) / (6.0 * a),
        (-2.0 * b + root_discriminant) / (6.0 * a),
    ):
        if 0.0 < root < 1.0:
            yield root


def tight_bounds(
    contours: list[list[list[list[float]]]],
) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for contour in contours:
        for curve in contour:
            x_values = [point[0] for point in curve]
            y_values = [point[1] for point in curve]
            xs.extend((x_values[0], x_values[3]))
            ys.extend((y_values[0], y_values[3]))
            xs.extend(cubic_value(x_values, time) for time in cubic_extrema(x_values))
            ys.extend(cubic_value(y_values, time) for time in cubic_extrema(y_values))
    if not xs or not ys or not all(math.isfinite(value) for value in (*xs, *ys)):
        raise ValueError("Manim SVG did not produce finite cubic ink")
    return min(xs), max(xs), min(ys), max(ys)


def manim_contours(mobject: MathTex) -> list[list[list[list[float]]]]:
    contours: list[list[list[list[float]]]] = []
    for member in mobject.family_members_with_points():
        for subpath in member.get_subpaths():
            if len(subpath) % 4 != 0:
                raise ValueError(
                    "Manim cubic subpath is not grouped into four control points"
                )
            contour = []
            for offset in range(0, len(subpath), 4):
                curve = subpath[offset : offset + 4]
                contour.append([[float(point[0]), float(point[1])] for point in curve])
            if contour:
                contours.append(contour)
    return contours


def normalized_contours(
    mobject: MathTex,
) -> tuple[list[list[list[list[float]]]], dict[str, float]]:
    contours = manim_contours(mobject)
    left, right, bottom, top = tight_bounds(contours)
    height = top - bottom
    if not math.isfinite(height) or height <= 0.0:
        raise ValueError("Manim SVG ink has no finite positive height")
    center_x = (left + right) / 2.0
    center_y = (bottom + top) / 2.0
    normalized = [
        [
            [
                [
                    round((point[0] - center_x) / height, 8),
                    round((point[1] - center_y) / height, 8),
                ]
                for point in curve
            ]
            for curve in contour
        ]
        for contour in contours
    ]
    normalized_left, normalized_right, normalized_bottom, normalized_top = tight_bounds(
        normalized
    )
    return normalized, {
        "bottom": round(normalized_bottom, 8),
        "left": round(normalized_left, 8),
        "right": round(normalized_right, 8),
        "top": round(normalized_top, 8),
    }


def rasterize(
    contours: list[list[list[list[float]]]],
    viewport: dict[str, float],
    width: int,
    height: int,
    samples_per_axis: int,
) -> tuple[list[str], bytes]:
    surface_width = width * samples_per_axis
    surface_height = height * samples_per_axis
    surface = cairo.ImageSurface(cairo.FORMAT_A8, surface_width, surface_height)
    context = cairo.Context(surface)
    context.set_antialias(cairo.ANTIALIAS_NONE)
    scale_x = surface_width / (viewport["right"] - viewport["left"])
    scale_y = surface_height / (viewport["top"] - viewport["bottom"])

    def pixel(point: list[float]) -> tuple[float, float]:
        return (
            (point[0] - viewport["left"]) * scale_x,
            (viewport["top"] - point[1]) * scale_y,
        )

    for contour in contours:
        context.move_to(*pixel(contour[0][0]))
        for curve in contour:
            context.curve_to(*pixel(curve[1]), *pixel(curve[2]), *pixel(curve[3]))
        context.close_path()
    context.set_fill_rule(cairo.FILL_RULE_WINDING)
    context.set_source_rgba(1.0, 1.0, 1.0, 1.0)
    context.fill()
    surface.flush()
    stride = surface.get_stride()
    pixels = memoryview(surface.get_data())

    rows = []
    coverage_bytes = bytearray()
    for pixel_y in range(height):
        row = []
        for pixel_x in range(width):
            coverage = 0
            for sample_y in range(samples_per_axis):
                for sample_x in range(samples_per_axis):
                    source_y = pixel_y * samples_per_axis + sample_y
                    source_x = pixel_x * samples_per_axis + sample_x
                    coverage += int(pixels[source_y * stride + source_x] >= 128)
            coverage_bytes.append(coverage)
            row.append(format(coverage, "x"))
        rows.append("".join(row))
    return rows, bytes(coverage_bytes)


def svg_view_box_values(svg: bytes) -> tuple[float, float, float, float]:
    root = ET.fromstring(svg)
    values = [
        float(value) for value in root.attrib["viewBox"].replace(",", " ").split()
    ]
    if len(values) != 4 or values[2] <= 0.0 or values[3] <= 0.0:
        raise ValueError("Manim SVG viewBox is invalid")
    return values[0], values[1], values[2], values[3]


def marked_svg_baseline_y(svg: bytes) -> float:
    root = ET.fromstring(svg)
    candidates = []
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "rect":
            continue
        width = float(element.attrib.get("width", "nan"))
        height = float(element.attrib.get("height", "nan"))
        if math.isclose(width, BASELINE_MARKER_WIDTH_BP, rel_tol=0.01) and math.isclose(
            height,
            BASELINE_MARKER_HEIGHT_BP,
            rel_tol=0.01,
        ):
            candidates.append(float(element.attrib["y"]) + height)
    if len(candidates) != 1 or not math.isfinite(candidates[0]):
        raise ValueError("marked Manim SVG did not contain exactly one baseline rule")
    return candidates[0]


def svg_view_box(svg: bytes, baseline_svg_y: float) -> dict[str, float]:
    minimum_x, minimum_y, width, height = svg_view_box_values(svg)
    # SVG y grows downward. Map the measured rule bottom (the TeX baseline)
    # into the same centered, unit-height, y-up convention as the outline.
    baseline = (minimum_y + height / 2.0 - baseline_svg_y) / height
    return {
        "baselineY": round(baseline, 8),
        "height": round(height, 8),
        "minimumX": round(minimum_x, 8),
        "minimumY": round(minimum_y, 8),
        "width": round(width, 8),
    }


def generate(output: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")
    references = output / "references"
    references.mkdir(parents=True)
    media_root = Path(tempfile.mkdtemp(prefix="poietra-mathtex-manim-media-"))
    try:
        config.media_dir = str(media_root)
        config.tex_dir = str(media_root / "Tex")
        generated_cases = []
        for case in CASES:
            mobject = MathTex(*case["texParts"])
            source_svg = Path(mobject.file_name)
            svg = source_svg.read_bytes()
            marked_parts = list(case["texParts"])
            marked_parts[0] = BASELINE_MARKER + marked_parts[0]
            marked_svg = Path(MathTex(*marked_parts).file_name).read_bytes()
            original_view_box = svg_view_box_values(svg)
            marked_view_box = svg_view_box_values(marked_svg)
            if not all(
                math.isclose(
                    original_view_box[index],
                    marked_view_box[index],
                    rel_tol=0.0,
                    abs_tol=1.0e-6,
                )
                for index in (1, 3)
            ):
                raise ValueError(
                    f"zero-size baseline marker changed the Manim SVG vertical viewBox for {case['id']}: "
                    f"{original_view_box!r} != {marked_view_box!r}"
                )
            baseline_svg_y = marked_svg_baseline_y(marked_svg)
            svg_name = f"{case['id']}.svg"
            (references / svg_name).write_bytes(svg)
            contours, bounds = normalized_contours(mobject)
            viewport = {
                "bottom": -0.6,
                "left": round(bounds["left"] * 1.25, 8),
                "right": round(bounds["right"] * 1.25, 8),
                "top": 0.6,
            }
            mask_rows, mask_bytes = rasterize(contours, viewport, 192, 64, 2)
            generated_cases.append(
                {
                    **case,
                    "maskRows": mask_rows,
                    "maskSha256": hashlib.sha256(mask_bytes).hexdigest(),
                    "normalizedBounds": bounds,
                    "svgFile": f"references/{svg_name}",
                    "svgSha256": hashlib.sha256(svg).hexdigest(),
                    "svgViewBox": svg_view_box(svg, baseline_svg_y),
                    "viewport": viewport,
                }
            )

        generated_unsupported_cases = []
        for case in UNSUPPORTED_CASES:
            try:
                MathTex(*case["texParts"])
            except ValueError:
                generated_unsupported_cases.append(
                    {**case, "expectedFailure": "latex-compile-error"}
                )
            else:
                raise ValueError(
                    f"pinned Manim unexpectedly compiled unsupported case {case['id']}"
                )

        generated_semantic_exclusions = []
        for case in SEMANTIC_EXCLUSIONS:
            candidate_contours, candidate_bounds = normalized_contours(
                MathTex(*case["texParts"])
            )
            reference_contours, reference_bounds = normalized_contours(
                MathTex(*case["referenceTexParts"])
            )
            if (
                candidate_contours != reference_contours
                or candidate_bounds != reference_bounds
            ):
                raise ValueError(
                    f"pinned Manim semantic relation changed for {case['id']}"
                )
            generated_semantic_exclusions.append(
                {**case, "expectedRelation": "normalized-outline-identical"}
            )

        generated_source_profile_cases = []
        for case in SOURCE_PROFILE_CASES:
            MathTex(*case["texParts"])
            generated_source_profile_cases.append(
                {**case, "expectedOutcome": "latex-compile-success"}
            )

        corpus = {
            "schema": "poietra.mathtex-manim-visual-parity",
            "version": 1,
            "referenceProducer": {
                "kind": "manim-mathtex-svg",
                "dockerImage": os.environ["POIETRA_MANIM_REFERENCE_IMAGE"],
                "manimVersion": manim.__version__,
                "latexVersion": command_version("latex"),
                "dvisvgmVersion": command_version("dvisvgm"),
                "generationCommand": "node scripts/regenerate-mathtex-manim-parity.mjs",
                "licenses": [
                    {
                        "component": "Manim Community",
                        "license": "MIT",
                        "source": "https://github.com/ManimCommunity/manim",
                    },
                    {
                        "component": "LaTeX",
                        "license": "LPPL-1.3c",
                        "source": "https://www.latex-project.org/lppl/",
                    },
                    {
                        "component": "dvisvgm",
                        "license": "GPL-3.0-or-later",
                        "source": "https://github.com/mgieseki/dvisvgm",
                    },
                    {
                        "component": "Computer Modern fonts",
                        "license": "Knuth-CTAN",
                        "source": "https://ctan.org/pkg/cm",
                    },
                ],
            },
            "comparison": {
                "kind": "normalized-filled-outline",
                "minimumIoU": 0.5,
                "maximumAspectRatioRelativeDelta": 0.2,
                "maximumBaselineAbsoluteDelta": 0.02,
                "maximumNormalizedBoundsAbsoluteDelta": 0.04,
                "maximumNormalizedFullImageMeanAbsoluteError": 0.05,
                "curveSteps": 12,
                "rasterHeightPx": 64,
                "rasterWidthPx": 192,
                "samplesPerAxis": 2,
                "statement": (
                    "Compares RaTeX output bounds, baseline position, filled-outline IoU, and "
                    "normalized full-image mean absolute error with cubic contours loaded by Manim "
                    "from the checked-in latex+dvisvgm SVG; it is not a RaTeX-to-KaTeX "
                    "self-comparison or a claim of exact parity."
                ),
            },
            "cases": generated_cases,
            "semanticExclusions": generated_semantic_exclusions,
            "unsupportedCases": generated_unsupported_cases,
        }
        (output / "corpus.json").write_text(
            json.dumps(corpus, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        source_profile = {
            "schema": "poietra.mathtex-manim-source-profile",
            "version": 1,
            "profile": "core-ams",
            "referenceProducer": {
                "kind": "manim-default-mathtex-compile",
                "dockerImage": os.environ["POIETRA_MANIM_REFERENCE_IMAGE"],
                "manimVersion": manim.__version__,
                "latexVersion": command_version("latex"),
                "dvisvgmVersion": command_version("dvisvgm"),
                "texCompiler": config.tex_template.tex_compiler,
                "texTemplateSha256": runtime_tex_template_digest(),
                "generationCommand": "node scripts/regenerate-mathtex-manim-parity.mjs",
            },
            "cases": generated_source_profile_cases,
        }
        (output / "source-profile.json").write_text(
            json.dumps(source_profile, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    finally:
        shutil.rmtree(media_root, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    generate(arguments.output)


if __name__ == "__main__":
    main()
