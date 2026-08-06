"""Generate bounded Cairo RGBA evidence for the official UpdatersExample."""

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
from manim.renderer._runtime_trace.decimal_glyphs import (
    HermeticDecimalNumberV1,
    load_decimal_glyph_provider_v1,
)


FAST_MANIM_COMMIT = "82353666a30abf48390d98eb796e1573a149030e"
FAST_MANIM_TREE = "2b95349bd0647908189e4db9be4d18a5b368db25"
GLYPH_PROVIDER_SHA256 = (
    "b95975405e4df8302088ac0b01afb55b42bd1892d8fa8161a1ca556e023e6322"
)
SOURCE_PATH = Path("example_scenes/basic.py")
SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}
FRAME_RATE = 60
DURATION_SECONDS = 6
RGBA_BYTES = VIEWPORT["widthPx"] * VIEWPORT["heightPx"] * 4
SAMPLES = (
    ("initial", 0, 0.0),
    ("descent", 75, 75 / FRAME_RATE),
    ("bottom", 150, 150 / FRAME_RATE),
    ("return", 225, 225 / FRAME_RATE),
    ("play-end", 299, 299 / FRAME_RATE),
    ("hold", 330, 330 / FRAME_RATE),
    # A six-second request retains the final captured presentation frame.
    ("duration-end", 359, 6.0),
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


def require_exact_checkout(fast_manim: Path) -> None:
    if git(fast_manim, "rev-parse", "HEAD") != FAST_MANIM_COMMIT:
        raise RuntimeError(
            "fast-manim HEAD does not match the pinned Cairo reference commit"
        )
    if git(fast_manim, "rev-parse", "HEAD^{tree}") != FAST_MANIM_TREE:
        raise RuntimeError(
            "fast-manim tree does not match the pinned Cairo reference tree"
        )
    tracked_changes = subprocess.run(
        ["git", "-C", str(fast_manim), "status", "--porcelain", "--untracked-files=no"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if tracked_changes:
        raise RuntimeError(
            "fast-manim has tracked changes outside the pinned producer identity"
        )


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
        "seed": 0,
        "transparent": False,
        "verbosity": "WARNING",
        "writeToMovie": False,
    }


def manim_config(values: dict[str, Any], media: Path) -> dict[str, Any]:
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
        "media_dir": str(media),
        "pixel_height": values["pixelHeight"],
        "pixel_width": values["pixelWidth"],
        "progress_bar": "none",
        "renderer": values["renderer"],
        "save_last_frame": values["saveLastFrame"],
        "save_pngs": values["savePngs"],
        "seed": values["seed"],
        "transparent": values["transparent"],
        "verbosity": values["verbosity"],
        "write_to_movie": values["writeToMovie"],
    }


def producer_identity(fast_manim: Path) -> dict[str, Any]:
    pycairo_module = Path(pycairo_extension.__file__).resolve()
    pillow_module = Path(pillow_imaging.__file__).resolve()
    python_executable = Path(sys.executable).resolve()
    decimal_resource = (
        fast_manim
        / "manim"
        / "renderer"
        / "_runtime_trace"
        / "data"
        / "decimal_glyphs_v1.json"
    )
    cairo_renderer = fast_manim / "manim" / "renderer" / "cairo_renderer.py"
    identity = {
        "cairoLibrarySha256": sha256_file(
            linked_library(pycairo_module, "libcairo.so.2")
        ),
        "cairoVersion": cairo.cairo_version_string(),
        "decimalGlyphResourceSha256": sha256_file(decimal_resource),
        "fastManimCommit": git(fast_manim, "rev-parse", "HEAD"),
        "fastManimTree": git(fast_manim, "rev-parse", "HEAD^{tree}"),
        "glyphProviderSha256": GLYPH_PROVIDER_SHA256,
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
        "rendererModuleSha256": sha256_file(cairo_renderer),
        "uvLockSha256": sha256_file(fast_manim / "uv.lock"),
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location(
        "poietra_updaters_cairo_reference_scene",
        source,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The production Runtime Trace runs this exact source with the sealed glyph
    # closure. Replacing only this global keeps the Cairo execution independent
    # of the trace recorder while avoiding host TeX and font state.
    module.DecimalNumber = HermeticDecimalNumberV1
    scene = getattr(module, "UpdatersExample", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define UpdatersExample(Scene)")
    return scene


def opaque_rgba(frame: object) -> bytes:
    pixels = np.asarray(frame)
    expected_shape = (VIEWPORT["heightPx"], VIEWPORT["widthPx"])
    if pixels.dtype != np.uint8 or pixels.shape[:2] != expected_shape:
        raise RuntimeError(
            f"Cairo returned {pixels.dtype} {pixels.shape}; expected uint8 {expected_shape}"
        )
    if pixels.shape == (*expected_shape, 3):
        rgba = np.empty((*expected_shape, 4), dtype=np.uint8)
        rgba[:, :, :3] = pixels
        rgba[:, :, 3] = 255
    elif pixels.shape == (*expected_shape, 4):
        rgba = np.ascontiguousarray(pixels)
    else:
        raise RuntimeError("Cairo returned an unsupported channel layout")
    if not np.all(rgba[:, :, 3] == 255):
        raise RuntimeError("opaque-black Cairo evidence must have opaque alpha")
    result = rgba.tobytes(order="C")
    if len(result) != RGBA_BYTES:
        raise RuntimeError("Cairo RGBA evidence has an unexpected byte length")
    return result


def render_sample_frames(scene_type: type[manim.Scene]) -> dict[str, bytes]:
    renderer = manim.CairoRenderer()
    camera = renderer.camera
    if (
        camera.pixel_height != VIEWPORT["heightPx"]
        or camera.pixel_width != VIEWPORT["widthPx"]
        or camera.frame_height != FRAME["height"]
        or camera.frame_width != FRAME["width"]
        or camera.background_opacity != 1.0
        or tuple(camera.background_color.to_rgba()) != (0.0, 0.0, 0.0, 1.0)
        or camera.get_cairo_context(camera.pixel_array).get_antialias()
        != cairo.Antialias.DEFAULT
    ):
        raise RuntimeError("the installed Cairo camera differs from the sealed config")
    sample_by_frame = {frame_index: sample_id for sample_id, frame_index, _ in SAMPLES}
    captured: dict[str, bytes] = {}

    def capture_add_frame(
        bound_renderer: manim.CairoRenderer,
        frame: object,
        num_frames: int = 1,
    ) -> None:
        first_frame_index = round(bound_renderer.time * FRAME_RATE)
        for frame_index in range(first_frame_index, first_frame_index + num_frames):
            sample_id = sample_by_frame.get(frame_index)
            if sample_id is not None:
                if sample_id in captured:
                    raise RuntimeError(f"captured Cairo sample {sample_id} twice")
                captured[sample_id] = opaque_rgba(frame)
        bound_renderer.advance_without_raster(num_frames)

    renderer.add_frame = types.MethodType(capture_add_frame, renderer)
    scene = scene_type(renderer=renderer)
    scene.setup()
    scene.construct()
    scene.tear_down()
    if round(renderer.time * FRAME_RATE) != FRAME_RATE * DURATION_SECONDS:
        raise RuntimeError(
            f"official UpdatersExample rendered {renderer.time} seconds; expected 6"
        )
    expected_ids = {sample_id for sample_id, _, _ in SAMPLES}
    if set(captured) != expected_ids:
        raise RuntimeError(
            f"Cairo captures differ: got {sorted(captured)}; expected {sorted(expected_ids)}"
        )
    # Runtime Trace V1 maps a duration-end request to presentation frame 359;
    # it does not invent a post-grid frame by repainting the torn-down Scene.
    return captured


def generate(output: Path, fast_manim: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")
    if not output.parent.is_dir():
        raise FileNotFoundError("the caller-provided output parent must already exist")
    if os.environ.get("PYTHONHASHSEED") != "0":
        raise RuntimeError("PYTHONHASHSEED=0 must be set before starting the generator")
    fast_manim = fast_manim.resolve(strict=True)
    require_exact_checkout(fast_manim)
    source = fast_manim / SOURCE_PATH
    if sha256_file(source) != SOURCE_SHA256:
        raise RuntimeError("official UpdatersExample source bytes do not match the pin")
    manim_module = Path(manim.__file__).resolve()
    if not manim_module.is_relative_to(fast_manim / "manim"):
        raise RuntimeError(
            "the imported Manim module does not belong to the pinned checkout"
        )
    provider = load_decimal_glyph_provider_v1()
    if provider.resource_digest != GLYPH_PROVIDER_SHA256:
        raise RuntimeError("the hermetic decimal glyph provider does not match the pin")
    producer = producer_identity(fast_manim)

    random.seed(0)
    np.random.seed(0)
    values = renderer_config()
    with tempfile.TemporaryDirectory(prefix="poietra-updaters-cairo-media-") as media:
        with tempconfig(manim_config(values, Path(media))):
            frames = render_sample_frames(load_scene(source))

    output.mkdir()
    frame_documents = []
    for sample_id, frame_index, request_sample_time in SAMPLES:
        rgba = frames[sample_id]
        path = f"{sample_id}.rgba"
        (output / path).write_bytes(rgba)
        frame_documents.append(
            {
                "capturedFrameIndex": frame_index,
                "capturedTime": frame_index / FRAME_RATE,
                "id": sample_id,
                "requestSampleTime": request_sample_time,
                "rgba": {
                    "byteLength": len(rgba),
                    "channelOrder": "rgba",
                    "path": path,
                    "rowOrder": "top-to-bottom",
                    "sha256": sha256(rgba),
                },
            }
        )

    document = {
        "frame": {
            "background": "opaque-black",
            "camera": FRAME,
            "colorDomain": "srgb-u8",
            "frameRate": FRAME_RATE,
            "viewport": VIEWPORT,
        },
        "frames": frame_documents,
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
            "className": "UpdatersExample",
            "decimalImplementation": "hermetic-runtime-trace-v1",
            "repository": "Poietra/fast-manim",
            "sourcePath": SOURCE_PATH.as_posix(),
            "sourceSha256": SOURCE_SHA256,
        },
        "schema": "poietra.updaters-cairo-reference",
        "version": 1,
    }
    (output / "reference.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fast-manim", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    generate(arguments.output.resolve(), arguments.fast_manim)


if __name__ == "__main__":
    main()
