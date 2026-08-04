"""Generate the pinned Cairo reference for fast-manim's official LineJoints Scene."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import random
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import cairo
import cairo._cairo as pycairo_extension
import manim
import numpy as np
import PIL
import PIL._imaging as pillow_imaging
from manim import tempconfig
from PIL import Image


EXPECTED_FAST_MANIM_COMMIT = "29d21a2bd213df8ffeed0454278aa86289d190b8"
EXPECTED_SOURCE_PATH = Path("example_scenes/basic.py")
EXPECTED_SOURCE_SHA256 = (
    "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
)
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}


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


def linked_library(module: Path, soname: str) -> Path:
    lines = subprocess.run(
        ["ldd", str(module)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    prefix = f"{soname} => "
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(prefix):
            path = Path(stripped.removeprefix(prefix).split(" ", 1)[0]).resolve()
            if path.is_file():
                return path
    raise RuntimeError(f"cannot resolve {soname} from {module}")


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location(
        "poietra_line_joints_cairo_reference_scene",
        source,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "LineJoints", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define LineJoints(Scene)")
    return scene


def renderer_config() -> dict[str, Any]:
    return {
        "antialias": "default",
        "backgroundColor": "#000000",
        "backgroundOpacity": 1,
        "cairoCompositor": False,
        "cairoCompositorFades": False,
        "cairoForkWorkers": 0,
        "cairoStaticLayers": False,
        "disableCaching": True,
        "format": "png",
        "frameHeight": FRAME["height"],
        "frameRate": 60,
        "frameWidth": FRAME["width"],
        "pixelHeight": VIEWPORT["heightPx"],
        "pixelWidth": VIEWPORT["widthPx"],
        "renderer": "cairo",
        "saveLastFrame": True,
        "transparent": False,
        "verbosity": "WARNING",
        "writeToMovie": False,
    }


def manim_config(values: dict[str, Any], media: str) -> dict[str, Any]:
    return {
        "background_color": values["backgroundColor"],
        "background_opacity": float(values["backgroundOpacity"]),
        "cairo_antialias": values["antialias"],
        "cairo_compositor": values["cairoCompositor"],
        "cairo_compositor_fades": values["cairoCompositorFades"],
        "cairo_fork_workers": values["cairoForkWorkers"],
        "cairo_static_layers": values["cairoStaticLayers"],
        "disable_caching": values["disableCaching"],
        "format": values["format"],
        "frame_height": float(values["frameHeight"]),
        "frame_rate": float(values["frameRate"]),
        "frame_width": float(values["frameWidth"]),
        "media_dir": media,
        "pixel_height": values["pixelHeight"],
        "pixel_width": values["pixelWidth"],
        "renderer": values["renderer"],
        "save_last_frame": values["saveLastFrame"],
        "transparent": values["transparent"],
        "verbosity": values["verbosity"],
        "write_to_movie": values["writeToMovie"],
    }


def producer_identity(fast_manim: Path) -> dict[str, Any]:
    pycairo_module = Path(pycairo_extension.__file__).resolve()
    pillow_module = Path(pillow_imaging.__file__).resolve()
    python_executable = Path(sys.executable).resolve()
    cairo_library = linked_library(pycairo_module, "libcairo.so.2")
    identity = {
        "cairoLibrarySha256": sha256_file(cairo_library),
        "cairoVersion": cairo.cairo_version_string(),
        "fastManimCommit": git(fast_manim, "rev-parse", "HEAD"),
        "fastManimTree": git(fast_manim, "rev-parse", "HEAD^{tree}"),
        "manimVersion": manim.__version__,
        "numpyVersion": np.__version__,
        "pillowImagingModuleSha256": sha256_file(pillow_module),
        "pillowVersion": PIL.__version__,
        "pycairoModuleSha256": sha256_file(pycairo_module),
        "pycairoVersion": cairo.version,
        "pythonExecutableSha256": sha256_file(python_executable),
        "pythonImplementation": platform.python_implementation(),
        "pythonVersion": platform.python_version(),
        "renderer": "cairo",
        "uvLockSha256": sha256_file(fast_manim / "uv.lock"),
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


def generate(output: Path, fast_manim: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")
    if os.environ.get("PYTHONHASHSEED") != "0":
        raise RuntimeError("PYTHONHASHSEED=0 must be set before starting the generator")

    fast_manim = fast_manim.resolve()
    installed_fast_manim = Path(manim.__file__).resolve().parent.parent
    if installed_fast_manim != fast_manim:
        raise RuntimeError(
            f"imported manim is from {installed_fast_manim}; expected {fast_manim}"
        )
    fast_manim_commit = git(fast_manim, "rev-parse", "HEAD")
    if fast_manim_commit != EXPECTED_FAST_MANIM_COMMIT:
        raise RuntimeError(
            f"fast-manim is {fast_manim_commit}; expected {EXPECTED_FAST_MANIM_COMMIT}"
        )
    if git(fast_manim, "status", "--porcelain"):
        raise RuntimeError("fast-manim checkout must be clean")

    source = fast_manim / EXPECTED_SOURCE_PATH
    source_bytes = source.read_bytes()
    source_digest = sha256(source_bytes)
    if source_digest != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            f"LineJoints source hashes to {source_digest}; expected {EXPECTED_SOURCE_SHA256}"
        )

    values = renderer_config()
    random.seed(0)
    np.random.seed(0)
    with tempfile.TemporaryDirectory(prefix="poietra-line-joints-cairo-") as media:
        with tempconfig(manim_config(values, media)):
            scene = load_scene(source)()
            scene.render()
            png = Path(scene.renderer.file_writer.image_file_path).read_bytes()

    output.mkdir(parents=True)
    png_path = output / "expected.png"
    png_path.write_bytes(png)
    rgba = Image.open(png_path).convert("RGBA").tobytes()
    producer = producer_identity(fast_manim)
    reference = {
        "frame": {
            "background": "opaque-black",
            "camera": FRAME,
            "colorDomain": "srgb-u8",
            "sampleTime": 0,
            "viewport": VIEWPORT,
        },
        "png": {
            "byteLength": len(png),
            "channelOrder": "rgba",
            "path": "expected.png",
            "rgbaByteLength": len(rgba),
            "rgbaSha256": sha256(rgba),
            "rowOrder": "top-to-bottom",
            "sha256": sha256(png),
        },
        "producer": producer,
        "rendererConfig": {
            "identitySha256": canonical_digest(values),
            "values": values,
        },
        "reproducibility": {
            "environment": {"PYTHONHASHSEED": "0"},
            "seeds": {"numpy": 0, "pythonRandom": 0},
        },
        "scene": {
            "className": "LineJoints",
            "repository": "Poietra/fast-manim",
            "sourcePath": EXPECTED_SOURCE_PATH.as_posix(),
            "sourceSha256": source_digest,
        },
        "schema": "poietra.line-joints-cairo-reference",
        "version": 1,
    }
    (output / "reference.json").write_text(
        json.dumps(reference, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fast-manim-repository", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    generate(
        arguments.output.resolve(),
        arguments.fast_manim_repository.resolve(),
    )


if __name__ == "__main__":
    main()
