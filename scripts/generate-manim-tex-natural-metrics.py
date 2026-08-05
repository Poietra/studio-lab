"""Generate pinned natural-size evidence for Manim Tex/MathTex.

Run with the fast-manim virtual environment and a real LaTeX toolchain::

    PATH=/path/to/TinyTeX/bin/x86_64-linux:$PATH \
      PYTHONHASHSEED=0 /path/to/fast-manim/.venv/bin/python \
      scripts/generate-manim-tex-natural-metrics.py \
      --fast-manim /path/to/fast-manim \
      --output fixtures/manim-tex-natural-metrics-v1

The generator deliberately uses regular Manim ``Tex``/``MathTex`` and its
LaTeX+dvisvgm route.  It never imports the RaTeX outline provider whose
unit-height output this independent evidence is intended to correlate.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
import platform
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import manim
import numpy as np
from manim import (
    DEFAULT_FONT_SIZE,
    DEFAULT_MOBJECT_TO_MOBJECT_BUFFER,
    DOWN,
    LARGE_BUFF,
    LEFT,
    MathTex,
    Tex,
    UP,
    VGroup,
    YELLOW,
    config,
    tempconfig,
)


FAST_MANIM_COMMIT = "842cdecc97a5ba32c2a30e0254c5f5dcd74382f0"
FAST_MANIM_TREE = "6fad77addc72e1a97440265e27d02630cf5b37b4"
SOURCE_PATH = Path("example_scenes/basic.py")
SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
GENERATOR_PATH = Path("scripts/generate-manim-tex-natural-metrics.py")
REFERENCE_FILE = "reference.json"
REFERENCE_DIGEST_FILE = "reference.json.sha256"
FORMULA = r"\sum_{k=1}^\infty {1 \over k^2} = {\pi^2 \over 6}"
TEXT = "This is a some text"
COORDINATE_DECIMALS = 12
POINT_DIGEST_DOMAIN = b"poietra.manim-tex-runtime-points.v1\0"
FRAME_WIDTH = 128 / 9
FRAME_HEIGHT = 8


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256(path.read_bytes())


def canonical_digest(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return sha256(encoded)


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def command_identity(name: str) -> dict[str, str]:
    executable_name = shutil.which(name)
    if executable_name is None:
        raise FileNotFoundError(f"required metric tool is unavailable: {name}")
    executable = Path(executable_name).resolve(strict=True)
    completed = subprocess.run(
        [name, "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    version_lines = (completed.stdout or completed.stderr).splitlines()
    if not version_lines:
        raise RuntimeError(f"{name} --version returned no output")
    return {
        "executableSha256": sha256_file(executable),
        "version": version_lines[0],
    }


def quantize(value: float) -> float:
    result = round(float(value), COORDINATE_DECIMALS)
    return 0.0 if result == 0.0 else result


def cubic_value(values: tuple[float, float, float, float], time: float) -> float:
    inverse = 1.0 - time
    return (
        inverse**3 * values[0]
        + 3.0 * inverse**2 * time * values[1]
        + 3.0 * inverse * time**2 * values[2]
        + time**3 * values[3]
    )


def cubic_extrema(values: tuple[float, float, float, float]) -> Iterable[float]:
    a = -values[0] + 3.0 * values[1] - 3.0 * values[2] + values[3]
    b = 3.0 * values[0] - 6.0 * values[1] + 3.0 * values[2]
    c = -3.0 * values[0] + 3.0 * values[1]
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


def bounds_document(values: tuple[float, float, float, float]) -> dict[str, float]:
    left, right, bottom, top = values
    if (
        not all(math.isfinite(value) for value in values)
        or right <= left
        or top <= bottom
    ):
        raise ValueError("metric bounds must be finite and positive")
    return {
        "bottom": quantize(bottom),
        "left": quantize(left),
        "right": quantize(right),
        "top": quantize(top),
    }


def point_bounds(points: np.ndarray) -> tuple[float, float, float, float]:
    if (
        not isinstance(points, np.ndarray)
        or points.ndim != 2
        or points.shape[1:] != (3,)
        or not len(points)
        or not bool(np.isfinite(points).all())
    ):
        raise ValueError("Manim metric points must be one finite 3D matrix")
    return (
        float(np.min(points[:, 0])),
        float(np.max(points[:, 0])),
        float(np.min(points[:, 1])),
        float(np.max(points[:, 1])),
    )


def tight_bounds(mobject: manim.Mobject) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for member in mobject.family_members_with_points():
        for subpath in member.get_subpaths():
            points = np.asarray(subpath, dtype=np.float64)
            if len(points) == 0 or len(points) % 4 != 0:
                raise ValueError("Manim cubic subpaths must contain complete curves")
            for offset in range(0, len(points), 4):
                curve = points[offset : offset + 4]
                x_values = tuple(float(value) for value in curve[:, 0])
                y_values = tuple(float(value) for value in curve[:, 1])
                xs.extend((x_values[0], x_values[3]))
                ys.extend((y_values[0], y_values[3]))
                xs.extend(
                    cubic_value(x_values, time) for time in cubic_extrema(x_values)
                )
                ys.extend(
                    cubic_value(y_values, time) for time in cubic_extrema(y_values)
                )
    if not xs or not ys:
        raise ValueError("Manim mobject has no cubic ink")
    return min(xs), max(xs), min(ys), max(ys)


def object_bounds(mobject: manim.Mobject) -> dict[str, Any]:
    center = mobject.get_center()
    if not bool(np.isfinite(center).all()):
        raise ValueError("Manim metric center must be finite")
    width = float(mobject.width)
    height = float(mobject.height)
    if (
        not math.isfinite(width)
        or not math.isfinite(height)
        or width <= 0.0
        or height <= 0.0
    ):
        raise ValueError("Manim natural size must be finite and positive")
    return {
        "anchorBounds": bounds_document(
            point_bounds(mobject.get_points_defining_boundary())
        ),
        "center": {
            "x": quantize(center[0]),
            "y": quantize(center[1]),
            "z": quantize(center[2]),
        },
        "size": {
            "height": quantize(height),
            "width": quantize(width),
        },
        "tightBounds": bounds_document(tight_bounds(mobject)),
    }


def points_digest(points: np.ndarray) -> str:
    if (
        points.ndim != 2
        or points.shape[1:] != (3,)
        or not bool(np.isfinite(points).all())
    ):
        raise ValueError("runtime point digest requires one finite 3D matrix")
    digest = hashlib.sha256()
    digest.update(POINT_DIGEST_DOMAIN)
    digest.update(struct.pack(">Q", len(points)))
    digest.update(struct.pack(">Q", points.shape[1]))
    for value in points.flat:
        digest.update(struct.pack(">d", float(value)))
    return digest.hexdigest()


def family_members_with_paths(
    mobject: manim.Mobject,
) -> list[tuple[tuple[int, ...], manim.Mobject]]:
    """Return Manim's drawable-family order with its actual tree paths."""
    members: list[tuple[tuple[int, ...], manim.Mobject]] = []
    visited: set[int] = set()

    def visit(member: manim.Mobject, path: tuple[int, ...]) -> None:
        identity = id(member)
        if identity in visited:
            return
        visited.add(identity)
        if member.has_points():
            members.append((path, member))
        for index, child in enumerate(member.submobjects):
            visit(child, (*path, index))

    visit(mobject, ())
    expected = list(mobject.family_members_with_points())
    if len(members) != len(expected) or any(
        actual is not expected_member
        for (_, actual), expected_member in zip(members, expected, strict=True)
    ):
        raise ValueError("Manim drawable-family traversal no longer matches get_family")
    return members


def svg_family_kinds(svg: bytes) -> list[str]:
    root = ET.fromstring(svg)
    page_groups = [
        element
        for element in root.iter()
        if element.tag.rsplit("}", 1)[-1] == "g"
        and element.attrib.get("id") == "unique000"
    ]
    if len(page_groups) != 1:
        raise ValueError("pinned Manim SVG must contain exactly one unique page group")
    kinds = []
    for element in page_groups[0].iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "g":
            continue
        if tag == "use":
            kinds.append("glyph")
        elif tag == "rect":
            kinds.append("rule")
        else:
            raise ValueError(f"unsupported pinned Manim SVG family element: {tag}")
    if not kinds:
        raise ValueError(
            "pinned Manim SVG must contain at least one drawable family element"
        )
    return kinds


def metric_snapshot(mobject: manim.Mobject, family_kinds: list[str]) -> dict[str, Any]:
    families = []
    members = family_members_with_paths(mobject)
    if len(members) != len(family_kinds):
        raise ValueError(
            "Manim family order no longer matches the pinned SVG drawable order"
        )
    for order, ((family_path, member), kind) in enumerate(
        zip(members, family_kinds, strict=True)
    ):
        families.append(
            {
                **object_bounds(member),
                "familyPath": list(family_path),
                "kind": kind,
                "order": order,
                "paint": {
                    "fillColor": member.get_fill_color().to_hex(),
                    "fillOpacity": quantize(member.get_fill_opacity()),
                    "strokeColor": member.get_stroke_color().to_hex(),
                    "strokeOpacity": quantize(member.get_stroke_opacity()),
                    "strokeWidth": quantize(member.get_stroke_width()),
                },
                "pointCount": len(member.points),
                "pointsSha256": points_digest(member.points),
                "runtimeType": f"{type(member).__module__}.{type(member).__qualname__}",
            }
        )
    if not families:
        raise ValueError(
            "Manim metric snapshot requires at least one drawable family member"
        )
    return {
        **object_bounds(mobject),
        "families": families,
        "familyCount": len(families),
    }


def constructor(
    kind: str,
    tex_parts: list[str],
    *,
    font_size: float,
    color_map: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    return {
        "argSeparator": "" if kind == "tex" else " ",
        "colorMap": color_map or [],
        "fontSize": font_size,
        "kind": kind,
        "texEnvironment": "center" if kind == "tex" else "align*",
        "texParts": tex_parts,
    }


def source_transform(
    scale: float = 1.0, x: float = 0.0, y: float = 0.0
) -> dict[str, Any]:
    return {
        "scale": scale,
        "shift": {"x": x, "y": y},
    }


def metric_case(
    case_id: str,
    natural_mobject: manim.Mobject,
    world_mobject: manim.Mobject,
    constructor_value: dict[str, Any],
    transform: dict[str, Any],
) -> dict[str, Any]:
    svg_path = Path(natural_mobject.file_name)
    svg_bytes = svg_path.read_bytes()
    family_kinds = svg_family_kinds(svg_bytes)
    return {
        "constructor": constructor_value,
        "id": case_id,
        "naturalMetrics": metric_snapshot(natural_mobject, family_kinds),
        "sourceSvg": {
            "byteLength": len(svg_bytes),
            "sha256": sha256(svg_bytes),
        },
        "sourceTransform": transform,
        "worldMetrics": metric_snapshot(world_mobject, family_kinds),
    }


def source_identity(fast_manim: Path) -> dict[str, Any]:
    source = fast_manim / SOURCE_PATH
    source_bytes = source.read_bytes()
    if sha256(source_bytes) != SOURCE_SHA256:
        raise RuntimeError(
            "the official basic.py source does not match its pinned digest"
        )
    source_text = source_bytes.decode("utf-8", errors="strict")
    tree = ast.parse(source_text, filename=str(SOURCE_PATH))
    candidates = [
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "WriteStuff"
    ]
    if len(candidates) != 1:
        raise RuntimeError(
            "the official source must contain exactly one WriteStuff class"
        )
    closure = ast.get_source_segment(source_text, candidates[0])
    if closure is None:
        raise RuntimeError("the WriteStuff source closure is unavailable")
    return {
        "classClosureSha256": sha256(closure.encode()),
        "className": "WriteStuff",
        "repository": "Poietra/fast-manim",
        "sourcePath": SOURCE_PATH.as_posix(),
        "sourceSha256": SOURCE_SHA256,
    }


def producer_identity(fast_manim: Path) -> dict[str, Any]:
    python_executable = Path(sys.executable).resolve(strict=True)
    identity = {
        "defaultFontSize": int(DEFAULT_FONT_SIZE),
        "fastManimCommit": FAST_MANIM_COMMIT,
        "fastManimTree": FAST_MANIM_TREE,
        "manimVersion": manim.__version__,
        "numpyVersion": np.__version__,
        "pythonExecutableSha256": sha256_file(python_executable),
        "pythonImplementation": platform.python_implementation(),
        "pythonVersion": platform.python_version(),
        "sceneConfig": {
            "frameHeight": FRAME_HEIGHT,
            "frameWidth": FRAME_WIDTH,
        },
        "texTemplate": {
            "bodySha256": sha256(config.tex_template.body.encode()),
            "compiler": str(config.tex_template.tex_compiler),
            "outputFormat": config.tex_template.output_format,
        },
        "texToolchain": {
            "dvisvgm": command_identity("dvisvgm"),
            "latex": command_identity("latex"),
        },
        "uvLockSha256": sha256_file(fast_manim / "uv.lock"),
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


def generate(output: Path, fast_manim: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")
    if os.environ.get("PYTHONHASHSEED") != "0":
        raise RuntimeError("PYTHONHASHSEED=0 must be set before starting the generator")

    fast_manim = fast_manim.resolve(strict=True)
    installed_fast_manim = Path(manim.__file__).resolve().parent.parent
    if installed_fast_manim != fast_manim:
        raise RuntimeError(
            f"imported manim is from {installed_fast_manim}; expected {fast_manim}"
        )
    if git(fast_manim, "rev-parse", "HEAD") != FAST_MANIM_COMMIT:
        raise RuntimeError("fast-manim checkout is not the pinned metrics commit")
    if git(fast_manim, "rev-parse", "HEAD^{tree}") != FAST_MANIM_TREE:
        raise RuntimeError("fast-manim checkout is not the pinned metrics tree")
    if (
        subprocess.run(
            ["git", "-C", str(fast_manim), "diff", "--quiet", "HEAD", "--"]
        ).returncode
        != 0
    ):
        raise RuntimeError("fast-manim tracked files must be clean")

    source = source_identity(fast_manim)
    producer = producer_identity(fast_manim)
    random.seed(0)
    np.random.seed(0)

    with tempfile.TemporaryDirectory(prefix="poietra-manim-tex-metrics-") as media:
        with tempconfig(
            {
                "disable_caching": True,
                "frame_height": FRAME_HEIGHT,
                "frame_width": FRAME_WIDTH,
                "media_dir": media,
                "progress_bar": "none",
                "tex_dir": str(Path(media) / "Tex"),
                "verbosity": "WARNING",
            }
        ):
            pi_default = MathTex(r"\pi")
            pi_explicit = MathTex(r"\pi", font_size=72)
            pi_transform_source = MathTex(r"\pi")
            pi_transformed = (
                pi_transform_source.copy().scale(7).shift(2.25 * LEFT + 1.5 * UP)
            )
            official_text = Tex(TEXT, tex_to_color_map={"text": YELLOW})
            official_math = MathTex(FORMULA)
            cases = [
                metric_case(
                    "pi-default-48",
                    pi_default,
                    pi_default,
                    constructor("mathtex", [r"\pi"], font_size=48),
                    source_transform(),
                ),
                metric_case(
                    "pi-explicit-72",
                    pi_explicit,
                    pi_explicit,
                    constructor("mathtex", [r"\pi"], font_size=72),
                    source_transform(),
                ),
                metric_case(
                    "pi-scale-7-shift",
                    pi_transform_source,
                    pi_transformed,
                    constructor("mathtex", [r"\pi"], font_size=48),
                    source_transform(7.0, -2.25, 1.5),
                ),
                metric_case(
                    "official-write-stuff-tex",
                    official_text,
                    official_text,
                    constructor(
                        "tex",
                        [TEXT],
                        font_size=48,
                        color_map=[{"color": YELLOW.to_hex(), "literal": "text"}],
                    ),
                    source_transform(),
                ),
                metric_case(
                    "official-write-stuff-mathtex",
                    official_math,
                    official_math,
                    constructor("mathtex", [FORMULA], font_size=48),
                    source_transform(),
                ),
            ]

            layout_text = Tex(TEXT, tex_to_color_map={"text": YELLOW})
            layout_math = MathTex(FORMULA)
            group = VGroup(layout_text, layout_math)
            group.arrange(DOWN)
            after_arrange = {
                "children": [
                    {
                        "caseId": "official-write-stuff-tex",
                        **object_bounds(layout_text),
                    },
                    {
                        "caseId": "official-write-stuff-mathtex",
                        **object_bounds(layout_math),
                    },
                ],
                "group": object_bounds(group),
            }
            arranged_width = float(group.width)
            target_width = float(config["frame_width"] - 2 * LARGE_BUFF)
            group.width = target_width
            after_width = {
                "children": [
                    {
                        "caseId": "official-write-stuff-tex",
                        **object_bounds(layout_text),
                    },
                    {
                        "caseId": "official-write-stuff-mathtex",
                        **object_bounds(layout_math),
                    },
                ],
                "group": object_bounds(group),
            }
            layout = {
                "afterArrange": after_arrange,
                "afterWidth": after_width,
                "arrange": {
                    "buffer": float(DEFAULT_MOBJECT_TO_MOBJECT_BUFFER),
                    "center": True,
                    "direction": {"x": 0.0, "y": -1.0},
                },
                "frameWidth": float(config["frame_width"]),
                "id": "official-write-stuff",
                "largeBuffer": float(LARGE_BUFF),
                "targetWidth": target_width,
                "uniformScale": target_width / arranged_width,
            }

    generator_path = Path(__file__).resolve()
    document = {
        "cases": cases,
        "generator": {
            "path": GENERATOR_PATH.as_posix(),
            "sha256": sha256_file(generator_path),
        },
        "layout": layout,
        "metricContract": {
            "anchorBounds": "VMobject family cubic start/end anchors",
            "coordinateDecimals": COORDINATE_DECIMALS,
            "coordinateSpace": "manim-scene-units",
            "fontSizeScaling": "reference bounds multiplied by requestedFontSize / 48 before source transforms",
            "naturalSize": "case naturalMetrics.size before source transforms, from Mobject width/height",
            "referenceFontSize": 48,
            "sourceTransformOrder": "constructor-font-size -> source-scale -> source-shift -> group-layout",
            "tightBounds": "analytic cubic extrema over family_members_with_points",
        },
        "producer": producer,
        "reproducibility": {
            "environment": {"PYTHONHASHSEED": "0"},
            "seeds": {"numpy": 0, "pythonRandom": 0},
        },
        "schema": "poietra.manim-tex-natural-metrics-reference",
        "source": source,
        "version": 1,
    }
    encoded = (
        json.dumps(
            document,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode()
    output.mkdir(parents=True)
    (output / REFERENCE_FILE).write_bytes(encoded)
    (output / REFERENCE_DIGEST_FILE).write_text(
        f"{sha256(encoded)}  {REFERENCE_FILE}\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fast-manim", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    generate(arguments.output, arguments.fast_manim)


if __name__ == "__main__":
    main()
