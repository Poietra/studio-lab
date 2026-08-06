"""Generate four independent Cairo samples for the official SquareToCircle slice."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import random
import subprocess
import tempfile
import types
from pathlib import Path
from typing import Any

import cairo
import manim
import numpy as np
from manim import tempconfig


FAST_MANIM_COMMIT = "68c1c9a649abcc64b36e80f967aac262a7ba92ac"
FAST_MANIM_TREE = "4e647408991999f132b5d48a6705571e8a82906f"
SOURCE_PATH = Path("example_scenes/basic.py")
SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}
FRAME_RATE = 60
RGBA_BYTES = VIEWPORT["widthPx"] * VIEWPORT["heightPx"] * 4
WINDING_ROOT = 1.5119159473817447
SAMPLES = (
    ("create-midpoint", 0, 0.5),
    ("transform-midpoint", 1, 1.5),
    ("analytic-winding-root", 1, WINDING_ROOT),
    ("fade-midpoint", 2, 2.5),
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256(path.read_bytes())


def canonical_digest(value: object) -> str:
    return sha256(
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    )


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def require_exact_checkout(fast_manim: Path) -> None:
    if git(fast_manim, "rev-parse", "HEAD") != FAST_MANIM_COMMIT:
        raise RuntimeError("fast-manim HEAD does not match the pinned Cairo producer")
    if git(fast_manim, "rev-parse", "HEAD^{tree}") != FAST_MANIM_TREE:
        raise RuntimeError("fast-manim tree does not match the pinned Cairo producer")
    tracked = subprocess.run(
        ["git", "-C", str(fast_manim), "status", "--porcelain", "--untracked-files=no"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if tracked:
        raise RuntimeError("fast-manim has tracked changes outside the pinned producer")


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
    identity = {
        "cairoVersion": cairo.cairo_version_string(),
        "fastManimCommit": git(fast_manim, "rev-parse", "HEAD"),
        "fastManimTree": git(fast_manim, "rev-parse", "HEAD^{tree}"),
        "manimVersion": manim.__version__,
        "numpyVersion": np.__version__,
        "pycairoVersion": cairo.version,
        "renderer": "cairo",
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location("poietra_square_to_circle_cairo_scene", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "SquareToCircle", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define SquareToCircle(Scene)")
    return scene


def opaque_rgba(frame: object) -> bytes:
    pixels = np.asarray(frame)
    expected = (VIEWPORT["heightPx"], VIEWPORT["widthPx"])
    if pixels.dtype != np.uint8 or pixels.shape[:2] != expected:
        raise RuntimeError(f"Cairo returned {pixels.dtype} {pixels.shape}; expected uint8 {expected}")
    if pixels.shape == (*expected, 3):
        rgba = np.empty((*expected, 4), dtype=np.uint8)
        rgba[:, :, :3] = pixels
        rgba[:, :, 3] = 255
    elif pixels.shape == (*expected, 4):
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
    root_local_time = WINDING_ROOT - 1

    class SampledScene(scene_type):
        def get_time_progression(
            self,
            run_time: float,
            description: str,
            n_iterations: int | None = None,
            override_skip_animations: bool = False,
        ):
            progression = super().get_time_progression(
                run_time, description, n_iterations, override_skip_animations
            )
            if self.renderer.num_plays != 1:
                return progression
            times = np.asarray(list(progression), dtype=np.float64)
            replacement = int(np.searchsorted(times, root_local_time))
            if replacement <= 0 or replacement >= len(times):
                raise RuntimeError("the analytic root is outside Transform's time grid")
            times[replacement] = root_local_time

            class ExactProgression:
                def __iter__(self):
                    return iter(times)

                def close(self) -> None:
                    progression.close()

            return ExactProgression()

    renderer = manim.CairoRenderer()
    camera = renderer.camera
    if (
        camera.pixel_height != VIEWPORT["heightPx"]
        or camera.pixel_width != VIEWPORT["widthPx"]
        or camera.frame_height != FRAME["height"]
        or camera.frame_width != FRAME["width"]
        or camera.background_opacity != 1.0
        or tuple(camera.background_color.to_rgba()) != (0.0, 0.0, 0.0, 1.0)
        or camera.get_cairo_context(camera.pixel_array).get_antialias() != cairo.Antialias.DEFAULT
    ):
        raise RuntimeError("the installed Cairo camera differs from the sealed config")

    targets = {(play, sample_time - play): sample_id for sample_id, play, sample_time in SAMPLES}
    captured: dict[str, bytes] = {}
    original_render = renderer.render

    def capture_render(
        bound_renderer: manim.CairoRenderer,
        scene: manim.Scene,
        local_time: float,
        moving_mobjects: object = None,
    ) -> None:
        original_render(scene, local_time, moving_mobjects)
        for (play, target_time), sample_id in targets.items():
            if bound_renderer.num_plays == play and float(local_time) == target_time:
                if sample_id in captured:
                    raise RuntimeError(f"captured Cairo sample {sample_id} twice")
                captured[sample_id] = opaque_rgba(bound_renderer._get_frame_for_writer())

    renderer.render = types.MethodType(capture_render, renderer)
    scene = SampledScene(renderer=renderer)
    scene.setup()
    scene.construct()
    scene.tear_down()
    if renderer.num_plays != 3 or round(renderer.time * FRAME_RATE) != 180:
        raise RuntimeError("SquareToCircle did not render its exact three-second slice")
    expected_ids = {sample_id for sample_id, _, _ in SAMPLES}
    if set(captured) != expected_ids:
        raise RuntimeError(f"Cairo captures differ: got {sorted(captured)}; expected {sorted(expected_ids)}")
    return captured


def generate(output: Path, fast_manim: Path, source_override: Path | None) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")
    if not output.parent.is_dir():
        raise FileNotFoundError("the caller-provided output parent must already exist")
    if os.environ.get("PYTHONHASHSEED") != "0":
        raise RuntimeError("PYTHONHASHSEED=0 must be set before starting the generator")
    fast_manim = fast_manim.resolve(strict=True)
    require_exact_checkout(fast_manim)
    source = fast_manim / SOURCE_PATH if source_override is None else source_override.resolve(strict=True)
    source_sha256 = sha256_file(source)
    if source_override is None and source_sha256 != SOURCE_SHA256:
        raise RuntimeError("official SquareToCircle source bytes do not match the pin")
    if not Path(manim.__file__).resolve().is_relative_to(fast_manim / "manim"):
        raise RuntimeError("the imported Manim module does not belong to the pinned checkout")

    random.seed(0)
    np.random.seed(0)
    values = renderer_config()
    with tempfile.TemporaryDirectory(prefix="poietra-square-to-circle-cairo-") as media:
        with tempconfig(manim_config(values, Path(media))):
            frames = render_sample_frames(load_scene(source))

    output.mkdir()
    frame_documents = []
    for sample_id, _, sample_time in SAMPLES:
        rgba = frames[sample_id]
        path = f"{sample_id}.rgba"
        (output / path).write_bytes(rgba)
        frame_documents.append(
            {
                "id": sample_id,
                "sampleTime": sample_time,
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
        "producer": producer_identity(fast_manim),
        "rendererConfig": {"identitySha256": canonical_digest(values), "values": values},
        "reproducibility": {
            "environment": {"PYTHONHASHSEED": "0"},
            "seeds": {"numpy": 0, "pythonRandom": 0},
        },
        "scene": {
            "className": "SquareToCircle",
            "repository": "Poietra/fast-manim",
            "slice": {"duration": 3, "start": 0},
            "sourcePath": SOURCE_PATH.as_posix(),
            "sourceSha256": source_sha256,
        },
        "schema": "poietra.square-to-circle-cairo-reference",
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
    parser.add_argument("--source", type=Path)
    arguments = parser.parse_args()
    generate(arguments.output.resolve(), arguments.fast_manim, arguments.source)


if __name__ == "__main__":
    main()
