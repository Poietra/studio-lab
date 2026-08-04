"""Generate pinned Cairo timeline references for the official SpiralInExample Scene."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import random
import shutil
import subprocess
import sys
import tempfile
import types
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


FAST_MANIM_COMMIT = "842cdecc97a5ba32c2a30e0254c5f5dcd74382f0"
FAST_MANIM_TREE = "6fad77addc72e1a97440265e27d02630cf5b37b4"
SOURCE_PATH = Path("example_scenes/basic.py")
SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}
FRAME_RATE = 60
SAMPLES = (
    ("start", 0.0),
    ("early-reveal", 0.1),
    ("spiral-midpoint", 0.5),
    ("spiral-end", 1.0),
    ("hold", 1.5),
    ("group-fade-midpoint", 2.5),
    ("end", 3.0),
)


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


def executable_identity(name: str) -> dict[str, str]:
    executable_name = shutil.which(name)
    if executable_name is None:
        raise FileNotFoundError(
            f"required reference-render tool is unavailable: {name}"
        )
    executable = Path(executable_name).resolve()
    version_lines = subprocess.run(
        [name, "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if not version_lines:
        raise RuntimeError(f"{name} --version returned no output")
    return {
        "executableSha256": sha256_file(executable),
        "version": version_lines[0],
    }


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location(
        "poietra_spiral_in_cairo_reference_scene",
        source,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "SpiralInExample", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define SpiralInExample(Scene)")
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
        "frameRate": FRAME_RATE,
        "frameWidth": FRAME["width"],
        "pixelHeight": VIEWPORT["heightPx"],
        "pixelWidth": VIEWPORT["widthPx"],
        "renderer": "cairo",
        "saveLastFrame": False,
        "savePngs": False,
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
        "progress_bar": "none",
        "renderer": values["renderer"],
        "save_last_frame": values["saveLastFrame"],
        "save_pngs": values["savePngs"],
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
        "texToolchain": {
            "dvisvgm": executable_identity("dvisvgm"),
            "latex": executable_identity("latex"),
        },
        "uvLockSha256": sha256_file(fast_manim / "uv.lock"),
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


def render_sample_frames(
    scene_type: type[manim.Scene],
) -> dict[str, Image.Image]:
    renderer = manim.CairoRenderer()
    sample_frame_indices = {
        round(sample_time * FRAME_RATE): sample_id
        for sample_id, sample_time in SAMPLES
        if sample_time < 3.0
    }
    captured: dict[str, Image.Image] = {}

    def capture_add_frame(
        bound_renderer: manim.CairoRenderer,
        frame: np.ndarray,
        num_frames: int = 1,
    ) -> None:
        first_frame_index = round(bound_renderer.time * FRAME_RATE)
        for frame_index in range(first_frame_index, first_frame_index + num_frames):
            sample_id = sample_frame_indices.get(frame_index)
            if sample_id is not None:
                if sample_id in captured:
                    raise RuntimeError(f"captured Cairo sample {sample_id} twice")
                captured[sample_id] = Image.fromarray(
                    np.array(frame, copy=True)
                ).convert("RGBA")
        bound_renderer.advance_without_raster(num_frames)

    renderer.add_frame = types.MethodType(capture_add_frame, renderer)
    scene = scene_type(renderer=renderer)
    scene.setup()
    scene.construct()
    scene.tear_down()
    if round(renderer.time * FRAME_RATE) != 180:
        raise RuntimeError(
            f"official SpiralInExample rendered {renderer.time} seconds; expected 3"
        )
    renderer.update_frame(scene)
    captured["end"] = Image.fromarray(renderer.get_frame()).convert("RGBA")
    expected_ids = {sample_id for sample_id, _ in SAMPLES}
    if set(captured) != expected_ids:
        raise RuntimeError(
            f"Cairo captures differ: got {sorted(captured)}; expected {sorted(expected_ids)}"
        )
    return captured


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
    if git(fast_manim, "rev-parse", "HEAD") != FAST_MANIM_COMMIT:
        raise RuntimeError(f"fast-manim must be pinned to {FAST_MANIM_COMMIT}")
    if git(fast_manim, "rev-parse", "HEAD^{tree}") != FAST_MANIM_TREE:
        raise RuntimeError(f"fast-manim tree must be pinned to {FAST_MANIM_TREE}")
    if git(fast_manim, "status", "--porcelain"):
        raise RuntimeError("fast-manim checkout must be clean")

    source = fast_manim / SOURCE_PATH
    source_digest = sha256_file(source)
    if source_digest != SOURCE_SHA256:
        raise RuntimeError(
            f"SpiralInExample source hashes to {source_digest}; expected {SOURCE_SHA256}"
        )

    values = renderer_config()
    random.seed(0)
    np.random.seed(0)
    with tempfile.TemporaryDirectory(prefix="poietra-spiral-in-cairo-") as media:
        with tempconfig(manim_config(values, media)):
            frames = render_sample_frames(load_scene(source))

    output.mkdir(parents=True)
    frame_records = []
    for sample_id, sample_time in SAMPLES:
        png_path = output / f"{sample_id}.png"
        frames[sample_id].save(png_path)
        png = png_path.read_bytes()
        rgba = frames[sample_id].tobytes()
        frame_records.append(
            {
                "id": sample_id,
                "png": {
                    "byteLength": len(png),
                    "channelOrder": "rgba",
                    "path": png_path.name,
                    "rgbaByteLength": len(rgba),
                    "rgbaSha256": sha256(rgba),
                    "rowOrder": "top-to-bottom",
                    "sha256": sha256(png),
                },
                "sampleTime": sample_time,
            }
        )

    producer = producer_identity(fast_manim)
    reference = {
        "frame": {
            "background": "opaque-black",
            "camera": FRAME,
            "colorDomain": "srgb-u8",
            "frameRate": FRAME_RATE,
            "viewport": VIEWPORT,
        },
        "frames": frame_records,
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
            "className": "SpiralInExample",
            "repository": "Poietra/fast-manim",
            "sourcePath": SOURCE_PATH.as_posix(),
            "sourceSha256": source_digest,
        },
        "schema": "poietra.spiral-in-cairo-reference",
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
    generate(arguments.output.resolve(), arguments.fast_manim_repository.resolve())


if __name__ == "__main__":
    main()
