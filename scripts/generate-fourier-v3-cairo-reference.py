"""Generate the pinned independent Cairo frames for FourierSeriesSquareWave."""

from __future__ import annotations

import argparse
import binascii
import hashlib
import importlib.util
import json
import os
import platform
import random
import shutil
import struct
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

FAST_MANIM_REPOSITORY = "https://github.com/Poietra/fast-manim.git"
FAST_MANIM_COMMIT = "edcf6578d7b5515d39f9378d48b2c5e8f9a99fa6"
FAST_MANIM_TREE = "806b84287549a874393046e35663f07a7ed576d4"
SOURCE_REPOSITORY = "https://github.com/HarleyCoops/Math-To-Manim.git"
SOURCE_COMMIT = "fcad0674c9791690d47664492fd1a052024b63a0"
SOURCE_TREE = "d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698"
SOURCE_PATH = Path(
    "legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py"
)
SOURCE_SHA256 = "3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72"
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}
FRAME_RATE = 60
TOTAL_FRAMES = 870
SAMPLES = (0, 300, 600, 630, 660, 690, 869)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256(path.read_bytes())


def canonical_digest(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return sha256(encoded)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    checksum = binascii.crc32(kind + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)


def node_value(expression: str) -> str:
    return subprocess.run(
        ["node", "--print", expression], check=True, capture_output=True, text=True
    ).stdout.strip()


def node_deflate(data: bytes) -> bytes:
    script = (
        "const z=require('node:zlib'),c=[];"
        "process.stdin.on('data',x=>c.push(x));"
        "process.stdin.on('end',()=>process.stdout.write("
        "z.deflateSync(Buffer.concat(c),{level:9})));"
    )
    return subprocess.run(
        ["node", "--eval", script], input=data, check=True, capture_output=True
    ).stdout


def encode_rgba_png(rgba: bytes) -> bytes:
    row_bytes = VIEWPORT["widthPx"] * 4
    if len(rgba) != row_bytes * VIEWPORT["heightPx"]:
        raise RuntimeError("Cairo RGBA evidence has an unexpected byte length")
    scanlines = b"".join(
        b"\x00" + rgba[offset : offset + row_bytes]
        for offset in range(0, len(rgba), row_bytes)
    )
    header = struct.pack(
        ">IIBBBBB", VIEWPORT["widthPx"], VIEWPORT["heightPx"], 8, 6, 0, 0, 0
    )
    return b"".join(
        (
            PNG_SIGNATURE,
            png_chunk(b"IHDR", header),
            png_chunk(b"IDAT", node_deflate(scanlines)),
            png_chunk(b"IEND", b""),
        )
    )


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def require_checkout(repository: Path, commit: str, tree: str, label: str) -> None:
    if git(repository, "rev-parse", "HEAD") != commit:
        raise RuntimeError(f"{label} HEAD does not match its pinned commit")
    if git(repository, "rev-parse", "HEAD^{tree}") != tree:
        raise RuntimeError(f"{label} tree does not match its pinned tree")
    if git(repository, "status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError(f"{label} has tracked changes outside its pinned identity")


def linked_library(module: Path, soname: str) -> Path:
    lines = subprocess.run(
        ["ldd", str(module)], check=True, capture_output=True, text=True
    ).stdout.splitlines()
    prefix = f"{soname} => "
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(prefix):
            candidate = Path(stripped.removeprefix(prefix).split(" ", 1)[0]).resolve()
            if candidate.is_file():
                return candidate
    raise RuntimeError(f"cannot resolve {soname} from {module}")


def executable_identity(name: str) -> dict[str, str]:
    executable_name = shutil.which(name)
    if executable_name is None:
        raise FileNotFoundError(
            f"required reference-render tool is unavailable: {name}"
        )
    executable = Path(executable_name).resolve()
    version_lines = subprocess.run(
        [name, "--version"], check=True, capture_output=True, text=True
    ).stdout.splitlines()
    if not version_lines:
        raise RuntimeError(f"{name} --version returned no output")
    return {"executableSha256": sha256_file(executable), "version": version_lines[0]}


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
        "frame_rate": values["frameRate"],
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
    node_executable_name = shutil.which("node")
    if node_executable_name is None:
        raise FileNotFoundError("required reference-render tool is unavailable: node")
    identity = {
        "cairoLibrarySha256": sha256_file(
            linked_library(pycairo_module, "libcairo.so.2")
        ),
        "cairoVersion": cairo.cairo_version_string(),
        "fastManimCommit": git(fast_manim, "rev-parse", "HEAD"),
        "fastManimTree": git(fast_manim, "rev-parse", "HEAD^{tree}"),
        "manimVersion": manim.__version__,
        "numpyVersion": np.__version__,
        "nodeExecutableSha256": sha256_file(Path(node_executable_name).resolve()),
        "nodeVersion": node_value("process.version"),
        "nodeZlibVersion": node_value("process.versions.zlib"),
        "pillowImagingModuleSha256": sha256_file(pillow_module),
        "pillowVersion": PIL.__version__,
        "pycairoModuleSha256": sha256_file(pycairo_module),
        "pycairoVersion": cairo.version,
        "pythonExecutableSha256": sha256_file(Path(sys.executable).resolve()),
        "pythonImplementation": platform.python_implementation(),
        "pythonVersion": platform.python_version(),
        "pngEncoder": "poietra-filter-none-node-zlib-level-9-v1",
        "renderer": "independent-cairo",
        "repository": FAST_MANIM_REPOSITORY,
        "texToolchain": {
            "dvisvgm": executable_identity("dvisvgm"),
            "latex": executable_identity("latex"),
        },
        "uvLockSha256": sha256_file(fast_manim / "uv.lock"),
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location(
        "poietra_fourier_v3_cairo_reference_scene", source
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "FourierSeriesSquareWave", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define FourierSeriesSquareWave(Scene)")
    return scene


def render_sample_frames(scene_type: type[manim.Scene]) -> dict[int, Image.Image]:
    renderer = manim.CairoRenderer()
    captured: dict[int, Image.Image] = {}

    def capture_add_frame(
        bound_renderer: manim.CairoRenderer, frame: np.ndarray, num_frames: int = 1
    ) -> None:
        first_frame = round(bound_renderer.time * FRAME_RATE)
        for frame_index in range(first_frame, first_frame + num_frames):
            if frame_index in SAMPLES:
                if frame_index in captured:
                    raise RuntimeError(f"captured Cairo frame {frame_index} twice")
                captured[frame_index] = Image.fromarray(
                    np.array(frame, copy=True)
                ).convert("RGBA")
        bound_renderer.advance_without_raster(num_frames)

    renderer.add_frame = types.MethodType(capture_add_frame, renderer)
    scene = scene_type(renderer=renderer)
    scene.setup()
    scene.construct()
    scene.tear_down()
    if round(renderer.time * FRAME_RATE) != TOTAL_FRAMES:
        raise RuntimeError(
            f"FourierSeriesSquareWave rendered {renderer.time} seconds; expected 14.5"
        )
    if set(captured) != set(SAMPLES):
        raise RuntimeError(
            f"Cairo captures differ: got {sorted(captured)}; expected {list(SAMPLES)}"
        )
    return captured


def generate(output: Path, fast_manim: Path, source_repository: Path) -> None:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite generator output: {output}")
    if not output.parent.is_dir():
        raise FileNotFoundError("the caller-provided output parent must already exist")
    if os.environ.get("PYTHONHASHSEED") != "0":
        raise RuntimeError("PYTHONHASHSEED=0 must be set before starting the generator")

    fast_manim = fast_manim.resolve(strict=True)
    source_repository = source_repository.resolve(strict=True)
    require_checkout(fast_manim, FAST_MANIM_COMMIT, FAST_MANIM_TREE, "fast-manim")
    require_checkout(source_repository, SOURCE_COMMIT, SOURCE_TREE, "Math-To-Manim")
    imported_manim = Path(manim.__file__).resolve()
    if not imported_manim.is_relative_to(fast_manim / "manim"):
        raise RuntimeError("the imported Manim module is not from the pinned checkout")
    source = source_repository / SOURCE_PATH
    if sha256_file(source) != SOURCE_SHA256:
        raise RuntimeError("FourierSeriesSquareWave source bytes do not match the pin")

    random.seed(0)
    np.random.seed(0)
    values = renderer_config()
    with (
        tempfile.TemporaryDirectory(prefix="poietra-fourier-cairo-media-") as media,
        tempconfig(manim_config(values, Path(media))),
    ):
        frames = render_sample_frames(load_scene(source))

    output.mkdir()
    frame_records = []
    for frame_index in SAMPLES:
        image = frames[frame_index]
        path = output / f"frame-{frame_index:03d}.png"
        rgba = image.tobytes()
        png = encode_rgba_png(rgba)
        path.write_bytes(png)
        frame_records.append(
            {
                "frameIndex": frame_index,
                "sampleTime": frame_index / FRAME_RATE,
                "png": {
                    "byteLength": len(png),
                    "path": path.name,
                    "rgbaByteLength": len(rgba),
                    "rgbaSha256": sha256(rgba),
                    "sha256": sha256(png),
                },
            }
        )

    producer = producer_identity(fast_manim)
    reference = {
        "schema": "poietra.fourier-v3-independent-cairo-reference",
        "version": 1,
        "codebase": {
            "repository": SOURCE_REPOSITORY,
            "revision": SOURCE_COMMIT,
            "tree": SOURCE_TREE,
        },
        "scene": {
            "className": "FourierSeriesSquareWave",
            "sourcePath": SOURCE_PATH.as_posix(),
            "sourceSha256": SOURCE_SHA256,
        },
        "producer": producer,
        "frame": {
            "background": "opaque-black",
            "camera": FRAME,
            "colorDomain": "srgb-u8",
            "frameRate": FRAME_RATE,
            "totalFrames": TOTAL_FRAMES,
            "viewport": VIEWPORT,
        },
        "rendererConfig": {
            **values,
            "identitySha256": canonical_digest(values),
        },
        "reproducibility": {
            "environment": {"PYTHONHASHSEED": "0"},
            "seeds": {"numpy": 0, "pythonRandom": 0},
        },
        "frames": frame_records,
    }
    (output / "reference.json").write_text(
        json.dumps(reference, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fast-manim", required=True, type=Path)
    parser.add_argument("--source-repository", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    generate(
        arguments.output.resolve(),
        arguments.fast_manim,
        arguments.source_repository,
    )


if __name__ == "__main__":
    main()
