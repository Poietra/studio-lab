"""Generate bounded independent Cairo evidence for OpeningManim's 0-15s slice.

The official Scene is executed unchanged.  In particular, ``Tex`` and
``MathTex`` use Manim's normal LaTeX/dvisvgm path; this generator never imports
or reconstructs the Runtime Trace V2 geometry resource.
"""

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


FAST_MANIM_COMMIT = "ae04f3610d1aa5ddce259d5ba507da2ec581c7d3"
FAST_MANIM_TREE = "41516d8b866a891adb22f47064b9bba5545fae15"
SOURCE_PATH = Path("example_scenes/basic.py")
SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"
FRAME = {"height": 8, "width": 128.0 / 9.0}
VIEWPORT = {"heightPx": 360, "widthPx": 640}
FRAME_RATE = 60
SLICE_FRAME_COUNT = 900
SLICE_DURATION_SECONDS = 15
RGBA_BYTES = VIEWPORT["widthPx"] * VIEWPORT["heightPx"] * 4
SAMPLES = (
    ("initial", 0, 0.0),
    ("opening-animation-midpoint", 60, 1.0),
    ("opening-play-end", 120, 2.0),
    ("opening-hold-last", 179, 179 / FRAME_RATE),
    ("transform-start", 180, 3.0),
    ("transform-midpoint", 210, 3.5),
    ("transform-play-end", 240, 4.0),
    ("wait-end", 299, 299 / FRAME_RATE),
    ("grid-create-start", 300, 5.0),
    ("grid-create-early", 330, 5.5),
    ("grid-create-midpoint", 390, 6.5),
    ("grid-create-last", 479, 479 / FRAME_RATE),
    ("grid-play-end", 480, 8.0),
    ("grid-wait-end", 539, 539 / FRAME_RATE),
    ("warp-start", 540, 9.0),
    ("warp-early", 570, 9.5),
    ("warp-midpoint", 630, 10.5),
    ("warp-late", 690, 11.5),
    ("warp-last", 719, 719 / FRAME_RATE),
    ("warp-play-end", 720, 12.0),
    ("warp-hold-last", 779, 779 / FRAME_RATE),
    ("final-title-transform-start", 780, 13.0),
    ("final-title-transform-midpoint", 810, 13.5),
    ("final-title-transform-last", 839, 839 / FRAME_RATE),
    ("final-title-transform-play-end", 840, 14.0),
    # A duration-end request retains the final captured presentation frame.
    ("terminal-hold-end", 899, 15.0),
)

EXPECTED_TEX_TOOLCHAIN = {
    "dvisvgm": {
        "executableSha256": "f71f47113ad9a77b9d2b01dd5d938e3537c60d1ee7f342ec273ed061d5e51b38",
        "version": "dvisvgm 3.6",
    },
    "kpsewhich": {
        "executableSha256": "c6236612bf273b4ce314c6fc5536401d1bd9e3597d1ee8b34900692879cd3fe9",
        "version": "kpathsea version 6.4.2",
    },
    "latex": {
        "executableSha256": "1c5ff71156ee990c3a18402cf06d3671ecf748bd84fb3983dbd5d62b600bc40b",
        "version": "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)",
    },
}

EXPECTED_TEX_ARTIFACTS = (
    {
        "role": "title",
        "svg": {
            "byteLength": 10_374,
            "fileName": "1b14fa4e39b328e9.svg",
            "sha256": "520a19f97782bb5ddae2009e67745d1e95f42af235715220b45a6d30d943b5d2",
        },
        "tex": {
            "byteLength": 251,
            "fileName": "1b14fa4e39b328e9.tex",
            "sha256": "1b14fa4e39b328e9e7cefa1c6635728d74461825efd834128132ace12e7e007c",
        },
    },
    {
        "role": "basel",
        "svg": {
            "byteLength": 10_725,
            "fileName": "e931457a6a9eb28b.svg",
            "sha256": "3bd472c6869a6b0019633570fc63861063cc4c98c39e6ee54da677278b63b133",
        },
        "tex": {
            "byteLength": 281,
            "fileName": "e931457a6a9eb28b.tex",
            "sha256": "e931457a6a9eb28bf2c3d4be9881d4070484a446f60454f37df94fb5eff7ffe3",
        },
    },
    {
        "role": "transform-title",
        "svg": {
            "byteLength": 10_990,
            "fileName": "476ae3b33141b587.svg",
            "sha256": "9c3c9259ea9028133a56221d2ba8d7ba4ad563df01f18b81e66382660098c912",
        },
        "tex": {
            "byteLength": 252,
            "fileName": "476ae3b33141b587.tex",
            "sha256": "476ae3b33141b5871c85e4a346270324d88b8afea0f441a8ae59f424162834e9",
        },
    },
    {
        "role": "grid-title",
        "svg": {
            "byteLength": 8_749,
            "fileName": "0b81212898da17f3.svg",
            "sha256": "f51da30b13a215ebd513c8004011a1281c46d34e52fc911da49d212c3c56c00a",
        },
        "tex": {
            "byteLength": 246,
            "fileName": "0b81212898da17f3.tex",
            "sha256": "0b81212898da17f3454281eb8d87490e33e0fbe83a402ed262e53cd7925dd2e2",
        },
    },
    {
        "role": "grid-transform-title",
        "svg": {
            "byteLength": 17_639,
            "fileName": "41ba434b08dcd2a6.svg",
            "sha256": "916d669120ce2eebe89de3556c42f39726fc74a00a61679bc29ba366c40bb48a",
        },
        "tex": {
            "byteLength": 285,
            "fileName": "41ba434b08dcd2a6.tex",
            "sha256": "41ba434b08dcd2a6c107eb68508594d175ac7f1a00a2dac88baec801b2b18f7b",
        },
    },
)


class OpeningSliceComplete(BaseException):
    """Producer-owned sentinel raised after the bounded 900th frame."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256(path.read_bytes())


def canonical_digest(value: object) -> str:
    encoded = json.dumps(
        value,
        allow_nan=False,
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
        raise RuntimeError("fast-manim HEAD does not match the pinned Cairo reference")
    if git(fast_manim, "rev-parse", "HEAD^{tree}") != FAST_MANIM_TREE:
        raise RuntimeError("fast-manim tree does not match the pinned Cairo reference")
    tracked_changes = subprocess.run(
        [
            "git",
            "-C",
            str(fast_manim),
            "status",
            "--porcelain",
            "--untracked-files=no",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if tracked_changes:
        raise RuntimeError("fast-manim has tracked changes outside the pinned identity")


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
    executable = Path(executable_name).resolve(strict=True)
    completed = subprocess.run(
        [name, "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    lines = (completed.stdout or completed.stderr).splitlines()
    if not lines:
        raise RuntimeError(f"{name} --version returned no output")
    return {"executableSha256": sha256_file(executable), "version": lines[0]}


def tex_toolchain_identity() -> dict[str, dict[str, str]]:
    identity = {
        "dvisvgm": executable_identity("dvisvgm"),
        "kpsewhich": executable_identity("kpsewhich"),
        "latex": executable_identity("latex"),
    }
    if identity != EXPECTED_TEX_TOOLCHAIN:
        raise RuntimeError(
            "the resolved TinyTeX toolchain differs from the sealed identity"
        )
    return identity


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
        "tex_dir": str(media / "Tex"),
        "transparent": values["transparent"],
        "verbosity": values["verbosity"],
        "write_to_movie": values["writeToMovie"],
    }


def load_scene(source: Path) -> type[manim.Scene]:
    spec = importlib.util.spec_from_file_location(
        "poietra_opening_manim_cairo_reference_scene",
        source,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference source: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scene = getattr(module, "OpeningManim", None)
    if not isinstance(scene, type) or not issubclass(scene, manim.Scene):
        raise TypeError("reference source must define OpeningManim(Scene)")
    # No globals are replaced: Tex and MathTex must stay on normal Manim.
    if module.Tex is not manim.Tex or module.MathTex is not manim.MathTex:
        raise RuntimeError(
            "official OpeningManim did not retain normal Tex constructors"
        )
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
        last_frame_index = first_frame_index + num_frames
        if (
            not isinstance(num_frames, int)
            or num_frames < 1
            or first_frame_index < 0
            or last_frame_index > SLICE_FRAME_COUNT
        ):
            raise RuntimeError("OpeningManim Cairo capture crossed its bounded slice")
        for frame_index in range(first_frame_index, last_frame_index):
            sample_id = sample_by_frame.get(frame_index)
            if sample_id is not None:
                if sample_id in captured:
                    raise RuntimeError(f"captured Cairo sample {sample_id} twice")
                captured[sample_id] = opaque_rgba(frame)
        bound_renderer.advance_without_raster(num_frames)
        completed_frames = round(bound_renderer.time * FRAME_RATE)
        if completed_frames == SLICE_FRAME_COUNT:
            raise OpeningSliceComplete
        if completed_frames > SLICE_FRAME_COUNT:
            raise RuntimeError("OpeningManim Cairo capture exceeded its bounded slice")

    renderer.add_frame = types.MethodType(capture_add_frame, renderer)
    scene = scene_type(renderer=renderer)
    scene.setup()
    completed = False
    try:
        scene.construct()
    except OpeningSliceComplete:
        completed = True
    finally:
        scene.tear_down()
    if not completed or round(renderer.time * FRAME_RATE) != SLICE_FRAME_COUNT:
        raise RuntimeError(
            "official OpeningManim did not complete its exact 0-15s slice"
        )
    expected_ids = {sample_id for sample_id, _, _ in SAMPLES}
    if set(captured) != expected_ids:
        raise RuntimeError(
            f"Cairo captures differ: got {sorted(captured)}; expected {sorted(expected_ids)}"
        )
    return captured


def collect_tex_artifacts(
    tex_dir: Path,
) -> tuple[list[dict[str, Any]], dict[str, bytes]]:
    expected_names = {
        item[kind]["fileName"]
        for item in EXPECTED_TEX_ARTIFACTS
        for kind in ("tex", "svg")
    }
    actual_names = {path.name for path in tex_dir.iterdir() if path.is_file()}
    if actual_names != expected_names:
        raise RuntimeError(
            f"OpeningManim Tex artifacts differ: got {sorted(actual_names)}; "
            f"expected {sorted(expected_names)}"
        )
    documents: list[dict[str, Any]] = []
    bytes_by_path: dict[str, bytes] = {}
    for expected in EXPECTED_TEX_ARTIFACTS:
        document: dict[str, Any] = {"role": expected["role"]}
        for kind in ("tex", "svg"):
            expected_file = expected[kind]
            source = tex_dir / expected_file["fileName"]
            data = source.read_bytes()
            if (
                len(data) != expected_file["byteLength"]
                or sha256(data) != expected_file["sha256"]
            ):
                raise RuntimeError(
                    f"OpeningManim {expected['role']} {kind} differs from its sealed bytes"
                )
            target_path = f"tex/{expected['role']}.{kind}"
            document[kind] = {
                "byteLength": len(data),
                "cacheFileName": expected_file["fileName"],
                "path": target_path,
                "sha256": sha256(data),
            }
            bytes_by_path[target_path] = data
        documents.append(document)
    return documents, bytes_by_path


def producer_identity(
    fast_manim: Path,
    tex_artifacts: list[dict[str, Any]],
    tex_toolchain: dict[str, dict[str, str]],
) -> dict[str, Any]:
    pycairo_module = Path(pycairo_extension.__file__).resolve()
    pillow_module = Path(pillow_imaging.__file__).resolve()
    python_executable = Path(sys.executable).resolve()
    cairo_renderer = fast_manim / "manim" / "renderer" / "cairo_renderer.py"
    identity = {
        "cairoLibrarySha256": sha256_file(
            linked_library(pycairo_module, "libcairo.so.2")
        ),
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
        "rendererModuleSha256": sha256_file(cairo_renderer),
        "texArtifacts": tex_artifacts,
        "texToolchain": tex_toolchain,
        "uvLockSha256": sha256_file(fast_manim / "uv.lock"),
    }
    return {**identity, "identitySha256": canonical_digest(identity)}


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
        raise RuntimeError("official OpeningManim source bytes do not match the pin")
    manim_module = Path(manim.__file__).resolve()
    if not manim_module.is_relative_to(fast_manim / "manim"):
        raise RuntimeError(
            "the imported Manim module does not belong to the pinned checkout"
        )

    random.seed(0)
    np.random.seed(0)
    values = renderer_config()
    toolchain = tex_toolchain_identity()
    with tempfile.TemporaryDirectory(prefix="poietra-opening-cairo-media-") as media:
        media_root = Path(media)
        with tempconfig(manim_config(values, media_root)):
            frames = render_sample_frames(load_scene(source))
        tex_artifacts, artifact_bytes = collect_tex_artifacts(media_root / "Tex")

    producer = producer_identity(fast_manim, tex_artifacts, toolchain)
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
    for relative_path, data in artifact_bytes.items():
        destination = output / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)

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
            "className": "OpeningManim",
            "repository": "Poietra/fast-manim",
            "slice": {
                "duration": SLICE_DURATION_SECONDS,
                "frameCount": SLICE_FRAME_COUNT,
                "start": 0,
            },
            "sourcePath": SOURCE_PATH.as_posix(),
            "sourceSha256": SOURCE_SHA256,
            "texImplementation": "normal-manim-latex-dvisvgm",
        },
        "schema": "poietra.opening-manim-cairo-reference",
        "version": 2,
    }
    (output / "reference.json").write_text(
        json.dumps(
            document, allow_nan=False, ensure_ascii=False, indent=2, sort_keys=True
        )
        + "\n",
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
