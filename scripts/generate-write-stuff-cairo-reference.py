"""Generate pinned Cairo timelines for official or Studio-edited WriteStuff."""

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


OFFICIAL_FAST_MANIM_COMMIT = "044a61aa0d868fc9e799588f2eb88006594b6c44"
OFFICIAL_FAST_MANIM_TREE = "996ad2b7375a6f911b1b00747eaad38834bde25c"
EDITED_FAST_MANIM_COMMIT = "8a1a4feb68c3ba47a2ff26c83b9bed4a6b095063"
EDITED_FAST_MANIM_TREE = "f1a5ef1b69711cf41c3424dd697ab75591942905"
SOURCE_PATH = Path("example_scenes/basic.py")
OFFICIAL_SOURCE_SHA256 = (
    "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
)
EDITED_SOURCE_SHA256 = (
    "37179e2a50fc22e784962d26a7778f5c273c296d5fcbccf04d89fb7e55885d98"
)
WRITE_STUFF_EDIT_ANCHOR = (
    '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n'
)
WRITE_STUFF_EDIT_REPLACEMENT = (
    WRITE_STUFF_EDIT_ANCHOR
    + "        example_tex.move_to((1.25, -0.5, 0))\n"
    + "        example_tex.scale(0.5)\n"
)
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}
FRAME_RATE = 60
SCENE_DURATION = 4.0
SAMPLES = (
    ("start", 0.0),
    ("tex-early", 0.25),
    ("tex-midpoint", 1.0),
    ("math-start", 2.0),
    ("math-midpoint", 2.5),
    ("math-end", 3.0),
    ("hold", 3.5),
    ("end", 4.0),
)
TEX_CACHE_FILES = (
    "2001da0d734dc8fc.tex",
    "2001da0d734dc8fc.svg",
    "5c2081ce9e37598c.tex",
    "5c2081ce9e37598c.svg",
    "8f249e3b899ba7b1.tex",
    "8f249e3b899ba7b1.svg",
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
        "poietra_write_stuff_cairo_reference_scene",
        source,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "WriteStuff", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define WriteStuff(Scene)")
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


def producer_identity(
    fast_manim: Path,
    tex_cache: Path | None,
) -> dict[str, Any]:
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
    if tex_cache is None:
        identity["texToolchain"] = {
            "dvisvgm": executable_identity("dvisvgm"),
            "latex": executable_identity("latex"),
        }
    else:
        identity["texCache"] = {
            "files": [
                {"path": name, "sha256": sha256_file(tex_cache / name)}
                for name in TEX_CACHE_FILES
            ],
            "kind": "pinned-manim-dvisvgm-svg",
        }
    return {**identity, "identitySha256": canonical_digest(identity)}


def install_tex_cache(source: Path, media: Path) -> None:
    actual = {path.name for path in source.iterdir() if path.is_file()}
    if actual != set(TEX_CACHE_FILES):
        raise RuntimeError(
            f"WriteStuff Tex cache differs: got {sorted(actual)}; "
            f"expected {sorted(TEX_CACHE_FILES)}"
        )
    destination = media / "Tex"
    destination.mkdir(parents=True)
    for name in TEX_CACHE_FILES:
        shutil.copyfile(source / name, destination / name)


def render_sample_frames(
    scene_type: type[manim.Scene],
) -> dict[str, Image.Image]:
    renderer = manim.CairoRenderer()
    sample_frame_indices = {
        round(sample_time * FRAME_RATE): sample_id
        for sample_id, sample_time in SAMPLES
        if sample_time < SCENE_DURATION
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
        if first_frame_index + num_frames == round(SCENE_DURATION * FRAME_RATE):
            captured["end"] = Image.fromarray(np.array(frame, copy=True)).convert(
                "RGBA"
            )
        bound_renderer.advance_without_raster(num_frames)

    renderer.add_frame = types.MethodType(capture_add_frame, renderer)
    scene = scene_type(renderer=renderer)
    scene.setup()
    scene.construct()
    scene.tear_down()
    if round(renderer.time * FRAME_RATE) != round(SCENE_DURATION * FRAME_RATE):
        raise RuntimeError(
            f"official WriteStuff rendered {renderer.time} seconds; expected {SCENE_DURATION:g}"
        )
    expected_ids = {sample_id for sample_id, _ in SAMPLES}
    if set(captured) != expected_ids:
        raise RuntimeError(
            f"Cairo captures differ: got {sorted(captured)}; expected {sorted(expected_ids)}"
        )
    return captured


def generate(
    output: Path,
    fast_manim: Path,
    variant: str,
    tex_cache: Path | None,
) -> None:
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
    expected_commit = (
        EDITED_FAST_MANIM_COMMIT
        if variant == "edited"
        else OFFICIAL_FAST_MANIM_COMMIT
    )
    expected_tree = (
        EDITED_FAST_MANIM_TREE if variant == "edited" else OFFICIAL_FAST_MANIM_TREE
    )
    if git(fast_manim, "rev-parse", "HEAD") != expected_commit:
        raise RuntimeError(f"fast-manim must be pinned to {expected_commit}")
    if git(fast_manim, "rev-parse", "HEAD^{tree}") != expected_tree:
        raise RuntimeError(f"fast-manim tree must be pinned to {expected_tree}")
    if git(fast_manim, "status", "--porcelain"):
        raise RuntimeError("fast-manim checkout must be clean")

    source = fast_manim / SOURCE_PATH
    official_source = source.read_text(encoding="utf-8")
    if sha256(official_source.encode()) != OFFICIAL_SOURCE_SHA256:
        raise RuntimeError(
            "official WriteStuff source differs from its pinned source generation"
        )
    rendered_source_text = official_source
    if variant == "edited":
        if official_source.count(WRITE_STUFF_EDIT_ANCHOR) != 1:
            raise RuntimeError("the WriteStuff post-layout edit anchor is ambiguous")
        rendered_source_text = official_source.replace(
            WRITE_STUFF_EDIT_ANCHOR,
            WRITE_STUFF_EDIT_REPLACEMENT,
            1,
        )
    source_digest = sha256(rendered_source_text.encode())
    expected_source_digest = (
        EDITED_SOURCE_SHA256 if variant == "edited" else OFFICIAL_SOURCE_SHA256
    )
    if source_digest != expected_source_digest:
        raise RuntimeError(
            f"WriteStuff source hashes to {source_digest}; expected {expected_source_digest}"
        )

    values = renderer_config()
    random.seed(0)
    np.random.seed(0)
    with tempfile.TemporaryDirectory(prefix="poietra-write-stuff-cairo-") as media_value:
        media = Path(media_value)
        if tex_cache is not None:
            install_tex_cache(tex_cache, media)
        rendered_source = source
        if variant == "edited":
            rendered_source = media / "edited_write_stuff.py"
            rendered_source.write_text(rendered_source_text, encoding="utf-8")
        with tempconfig(manim_config(values, str(media))):
            frames = render_sample_frames(load_scene(rendered_source))

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

    producer = producer_identity(fast_manim, tex_cache)
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
            "className": "WriteStuff",
            "repository": "Poietra/fast-manim",
            "sourcePath": SOURCE_PATH.as_posix(),
            "sourceSha256": source_digest,
        },
        "schema": "poietra.write-stuff-cairo-reference",
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
    parser.add_argument("--tex-cache", type=Path)
    parser.add_argument(
        "--variant",
        choices=("edited", "official"),
        default="official",
    )
    arguments = parser.parse_args()
    generate(
        arguments.output.resolve(),
        arguments.fast_manim_repository.resolve(),
        arguments.variant,
        arguments.tex_cache.resolve() if arguments.tex_cache is not None else None,
    )


if __name__ == "__main__":
    main()
