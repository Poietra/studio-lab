"""Generate the pinned Cairo reference for the real Studio preview Scene."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import platform
import random
import subprocess
import tempfile
from pathlib import Path

import cairo
import manim
import numpy as np
import PIL
from manim import tempconfig
from PIL import Image


EXPECTED_FAST_MANIM_COMMIT = "d2480e8096a5cac64f7f86ed1d0d01f5c87839e3"
VIEWPORT = {"heightPx": 468, "widthPx": 832}
FRAME = {"height": 8.0, "width": 128.0 / 9.0}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location("poietra_compositor_reference_scene", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "RealPreviewScene", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define RealPreviewScene(Scene)")
    return scene


def generate(output: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")

    repository = Path(__file__).resolve().parent.parent
    source = repository / "fixtures" / "real-preview-harness" / "scene.py"
    fast_manim = Path(manim.__file__).resolve().parent.parent
    fast_manim_commit = git(fast_manim, "rev-parse", "HEAD")
    if fast_manim_commit != EXPECTED_FAST_MANIM_COMMIT:
        raise RuntimeError(
            f"fast-manim is {fast_manim_commit}; expected {EXPECTED_FAST_MANIM_COMMIT}"
        )
    if git(fast_manim, "status", "--porcelain"):
        raise RuntimeError("fast-manim checkout must be clean")

    random.seed(0)
    np.random.seed(0)
    with tempfile.TemporaryDirectory(prefix="poietra-manim-compositor-") as media:
        with tempconfig(
            {
                "disable_caching": True,
                "background_color": "#000000",
                "background_opacity": 1.0,
                "cairo_antialias": "default",
                "cairo_compositor": False,
                "cairo_compositor_fades": False,
                "cairo_fork_workers": 0,
                "cairo_static_layers": False,
                "format": "png",
                "frame_rate": 60.0,
                "frame_height": FRAME["height"],
                "frame_width": FRAME["width"],
                "media_dir": media,
                "pixel_height": VIEWPORT["heightPx"],
                "pixel_width": VIEWPORT["widthPx"],
                "renderer": "cairo",
                "save_last_frame": True,
                "transparent": False,
                "verbosity": "WARNING",
                "write_to_movie": False,
            }
        ):
            scene = load_scene(source)()
            scene.render()
            png = Path(scene.renderer.file_writer.image_file_path).read_bytes()

    output.mkdir(parents=True)
    png_path = output / "expected.png"
    png_path.write_bytes(png)
    rgba = Image.open(png_path).convert("RGBA").tobytes()
    source_bytes = source.read_bytes()
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
        "producer": {
            "cairoVersion": cairo.cairo_version_string(),
            "fastManimCommit": fast_manim_commit,
            "manimVersion": manim.__version__,
            "pillowVersion": PIL.__version__,
            "pycairoVersion": cairo.version,
            "pythonVersion": platform.python_version(),
            "renderer": "cairo",
        },
        "rendererConfig": {
            "antialias": "default",
            "backgroundColor": "#000000",
            "backgroundOpacity": 1.0,
            "cairoCompositor": False,
            "cairoCompositorFades": False,
            "cairoForkWorkers": 0,
            "cairoStaticLayers": False,
            "disableCaching": True,
            "frameRate": 60.0,
            "saveLastFrame": True,
            "transparent": False,
            "writeToMovie": False,
        },
        "scene": {
            "className": "RealPreviewScene",
            "sourcePath": "fixtures/real-preview-harness/scene.py",
            "sourceSha256": sha256(source_bytes),
        },
        "schema": "poietra.manim-compositor-reference",
        "version": 1,
    }
    (output / "reference.json").write_text(
        json.dumps(reference, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    generate(parser.parse_args().output.resolve())


if __name__ == "__main__":
    main()
