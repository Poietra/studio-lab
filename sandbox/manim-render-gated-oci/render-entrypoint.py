"""Run one bounded Manim render behind the fixed OCI gate.

The untrusted Scene only receives a credential-free environment, a source file,
and an optional digest-bound ``image.png`` inside container tmpfs. PID 1 kills
and reaps every descendant before it publishes a correlated terminal marker
and enters its broker-readable state.
"""

from __future__ import annotations

import base64
import ctypes
import errno
import hashlib
import hmac
import io
import json
import os
import resource
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

MAGIC = b"POIETR1\x00"
VERSION = 1
HEADER_BYTES = 80
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_ASSET_BYTES = 512 * 1024
MAX_REQUEST_BYTES = MAX_SOURCE_BYTES + 4 * ((MAX_ASSET_BYTES + 2) // 3) + 64 * 1024
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
MAX_VIDEO_DURATION_SECONDS = 15 * 60
READY = b"POIETRA_RENDER_GATE_READY_V1\n"
TARGET = ("/opt/venv/bin/python", "/opt/poietra/render-entrypoint.py")
READY_PROCESS_NAME = b"poietra-ready"
RUNTIME_ROOT = Path("/run/poietra")
SOURCE_PATH = RUNTIME_ROOT / "tmp" / "scene.py"
PROJECT_PNG_PATH = RUNTIME_ROOT / "tmp" / "image.png"
MEDIA_ROOT = RUNTIME_ROOT / "tmp" / "media"
OUTPUT_ROOT = RUNTIME_ROOT / "output"
TERMINAL_PATH = OUTPUT_ROOT / "terminal.json"
TARGET_ENVIRONMENT = {
    "HOME": "/run/poietra/home",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONHASHSEED": "0",
    "PYTHONNOUSERSITE": "1",
    "PYTHONPATH": "/opt/fast-manim",
    "TMPDIR": "/run/poietra/tmp",
    "TZ": "UTC",
    "XDG_CACHE_HOME": "/run/poietra/cache",
    "XDG_CONFIG_HOME": "/run/poietra/config",
    "XDG_DATA_HOME": "/run/poietra/data",
}


class RenderFailure(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _read_exact(stream: object, byte_length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_length
    while remaining:
        chunk = stream.read(remaining)  # type: ignore[attr-defined]
        if not chunk:
            raise RuntimeError("The authenticated request ended early.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _private_runtime() -> None:
    if RUNTIME_ROOT.resolve() != RUNTIME_ROOT:
        raise RuntimeError("The runtime root is not canonical.")
    root_status = RUNTIME_ROOT.stat(follow_symlinks=False)
    if (
        RUNTIME_ROOT.is_symlink()
        or root_status.st_uid != os.getuid()
        or root_status.st_gid != os.getgid()
        or root_status.st_mode & 0o777 != 0o700
    ):
        raise RuntimeError("The runtime root is not private.")
    for name in ("cache", "config", "data", "home", "tmp"):
        directory = RUNTIME_ROOT / name
        directory.mkdir(mode=0o700)
        status = directory.stat(follow_symlinks=False)
        if directory.is_symlink() or status.st_uid != os.getuid() or status.st_mode & 0o077:
            raise RuntimeError("A runtime directory is not private.")
    OUTPUT_ROOT.mkdir(mode=0o700)
    output = OUTPUT_ROOT.stat(follow_symlinks=False)
    if OUTPUT_ROOT.is_symlink() or not OUTPUT_ROOT.is_dir() or output.st_uid != os.getuid() or output.st_mode & 0o077:
        raise RuntimeError("The render output directory is not private.")


def _assert_outbound_network_blocked() -> None:
    try:
        outbound = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EPERM):
            return
        raise RuntimeError("The outbound network check was inconclusive.") from error
    try:
        outbound.settimeout(0.2)
        outbound.connect(("1.1.1.1", 80))
    except OSError:
        pass
    else:
        raise RuntimeError("The OCI process has outbound network access.")
    finally:
        outbound.close()


def _runtime_confinement() -> None:
    if os.getuid() != 65532 or os.getgid() != 65532 or os.getpid() != 1:
        raise RuntimeError("The OCI process identity drifted.")
    status = Path("/proc/self/status").read_text(encoding="utf-8")
    if "CapEff:\t0000000000000000" not in status or "NoNewPrivs:\t1" not in status:
        raise RuntimeError("The OCI privilege boundary drifted.")
    if resource.getrlimit(resource.RLIMIT_NOFILE) != (256, 256):
        raise RuntimeError("The OCI descriptor limit drifted.")
    if resource.getrlimit(resource.RLIMIT_CORE) != (0, 0):
        raise RuntimeError("The OCI core limit drifted.")
    if resource.getrlimit(resource.RLIMIT_FSIZE) != (MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES):
        raise RuntimeError("The OCI file-size limit drifted.")

    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = (
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    )
    prctl.restype = ctypes.c_int
    if prctl(4, 0, 0, 0, 0) != 0 or prctl(3, 0, 0, 0, 0) != 0:
        raise RuntimeError("PID 1 could not become non-dumpable before untrusted execution.")

    try:
        descriptor = os.open("/opt/poietra/render-entrypoint.py", os.O_WRONLY | os.O_APPEND)
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
            raise RuntimeError("The read-only root filesystem check was inconclusive.") from error
    else:
        os.close(descriptor)
        raise RuntimeError("The OCI root filesystem is writable.")
    _assert_outbound_network_blocked()

    mount_target = RUNTIME_ROOT / "tmp" / "mount-target"
    mount_target.mkdir(mode=0o700)
    mount = libc.mount
    mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)
    mount.restype = ctypes.c_int
    if mount(b"none", os.fsencode(mount_target), b"tmpfs", 0, None) != -1 or ctypes.get_errno() != errno.EPERM:
        raise RuntimeError("The OCI process can create mounts.")


def _sealed_request() -> tuple[dict[str, object], str]:
    stream = sys.stdin.buffer
    header = _read_exact(stream, HEADER_BYTES)
    magic, version, byte_length, expected_digest, execution_digest = struct.unpack(">8sII32s32s", header)
    if magic != MAGIC or version != VERSION or byte_length > MAX_REQUEST_BYTES:
        raise RuntimeError("The authenticated request header is invalid.")
    body = _read_exact(stream, byte_length)
    if stream.read(1) != b"":
        raise RuntimeError("The authenticated request has trailing bytes.")
    if not hmac.compare_digest(hashlib.sha256(body).digest(), expected_digest):
        raise RuntimeError("The authenticated request digest is invalid.")
    try:
        request = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("The authenticated request is not valid JSON.") from error
    if not isinstance(request, dict):
        raise TypeError("The authenticated request is not an object.")
    return request, execution_digest.hex()


def _validated_project_png(value: object) -> bytes:
    expected = {"byteLength", "bytesBase64", "digest", "height", "logicalPath", "mediaType", "width"}
    if not isinstance(value, dict) or set(value) != expected:
        raise RuntimeError("The render asset shape is invalid.")
    encoded = value.get("bytesBase64")
    byte_length = value.get("byteLength")
    digest = value.get("digest")
    width = value.get("width")
    height = value.get("height")
    if (
        not isinstance(encoded, str)
        or len(encoded) > 4 * ((MAX_ASSET_BYTES + 2) // 3)
        or not isinstance(byte_length, int)
        or isinstance(byte_length, bool)
        or byte_length < 1
        or byte_length > MAX_ASSET_BYTES
        or not isinstance(digest, str)
        or value.get("logicalPath") != "image.png"
        or value.get("mediaType") != "image/png"
        or not isinstance(width, int)
        or isinstance(width, bool)
        or not isinstance(height, int)
        or isinstance(height, bool)
        or width < 1
        or height < 1
        or width > 2048
        or height > 2048
        or width * height > 4_194_304
    ):
        raise RuntimeError("The render asset metadata is invalid.")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise RuntimeError("The render asset encoding is invalid.") from error
    if (
        base64.b64encode(decoded).decode("ascii") != encoded
        or len(decoded) != byte_length
        or not hmac.compare_digest(hashlib.sha256(decoded).hexdigest(), digest)
    ):
        raise RuntimeError("The render asset correlation is invalid.")

    from PIL import Image

    try:
        with Image.open(io.BytesIO(decoded)) as image:
            if image.format != "PNG" or image.size != (width, height) or getattr(image, "n_frames", 1) != 1:
                raise RuntimeError("The render asset PNG metadata is invalid.")
            image.verify()
        with Image.open(io.BytesIO(decoded)) as image:
            image.load()
            if image.size != (width, height):
                raise RuntimeError("The render asset PNG dimensions changed while decoding.")
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("The render asset PNG is invalid.") from error
    return decoded


def _validated_request(request: dict[str, object]) -> tuple[str, str, str, bytes | None]:
    expected = {
        "assets",
        "deadlineEpochMs",
        "fenceToken",
        "jobId",
        "output",
        "profileDigest",
        "projectId",
        "runtimeDigest",
        "sceneFrame",
        "sceneName",
        "schema",
        "sessionId",
        "source",
        "sourceDigest",
        "sourcePath",
        "tenantId",
        "version",
    }
    if set(request) != expected or request.get("schema") != "poietra.manim-render-sandbox-request" or request.get("version") != 2:
        raise RuntimeError("The render request shape is invalid.")
    source = request.get("source")
    scene_name = request.get("sceneName")
    source_digest = request.get("sourceDigest")
    output = request.get("output")
    scene_frame = request.get("sceneFrame")
    assets = request.get("assets")
    if (
        not isinstance(source, str)
        or len(source.encode("utf-8")) > MAX_SOURCE_BYTES
        or not isinstance(scene_name, str)
        or not scene_name.isidentifier()
        or not scene_name.isascii()
        or not isinstance(source_digest, str)
        or hashlib.sha256(source.encode("utf-8")).hexdigest() != source_digest
        or not isinstance(output, dict)
        or set(output) != {"frameRate", "kind", "mediaType", "pixelHeight", "pixelWidth"}
        or not isinstance(scene_frame, dict)
        or set(scene_frame) != {"height", "width"}
        or scene_frame.get("height") != 8
        or scene_frame.get("width") != 128 / 9
        or not isinstance(assets, list)
        or len(assets) > 1
    ):
        raise RuntimeError("The render request correlation is invalid.")
    kind = output.get("kind")
    media_type = output.get("mediaType")
    if (
        (kind, media_type) not in (("video", "video/mp4"), ("thumbnail", "image/png"))
        or output.get("frameRate") != 15
        or output.get("pixelHeight") != 480
        or output.get("pixelWidth") != 854
    ):
        raise RuntimeError("The render media profile is invalid.")
    project_png = _validated_project_png(assets[0]) if assets else None
    return source, scene_name, kind, project_png


def _write_terminal(value: dict[str, object]) -> None:
    temporary = OUTPUT_ROOT / ".terminal.tmp"
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    with temporary.open("xb") as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(TERMINAL_PATH)


def _one_rendered_file(file_name: str) -> Path:
    candidates = [path for path in MEDIA_ROOT.rglob(file_name) if path.is_file() and not path.is_symlink()]
    if len(candidates) != 1:
        raise RenderFailure("media-missing")
    status = candidates[0].stat(follow_symlinks=False)
    if status.st_size <= 0 or status.st_size > MAX_ARTIFACT_BYTES:
        raise RenderFailure("media-invalid")
    return candidates[0]


def _open_trusted_artifact(path: Path) -> object:
    try:
        media_root = MEDIA_ROOT.resolve(strict=True)
        candidate = path.resolve(strict=True)
    except OSError as error:
        raise RenderFailure("media-invalid") from error
    if media_root != MEDIA_ROOT or candidate != path or not candidate.is_relative_to(media_root):
        raise RenderFailure("media-invalid")
    try:
        descriptor = os.open(candidate, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode) or status.st_size <= 0 or status.st_size > MAX_ARTIFACT_BYTES:
            raise RenderFailure("media-invalid")
        return os.fdopen(descriptor, "rb", closefd=True)
    except Exception:
        if "descriptor" in locals():
            os.close(descriptor)
        raise


def _validate_png(path: Path) -> None:
    from PIL import Image

    try:
        with _open_trusted_artifact(path) as stream, Image.open(stream) as image:
            if image.format != "PNG" or image.size != (854, 480) or getattr(image, "n_frames", 1) != 1:
                raise RenderFailure("media-invalid")
            image.verify()
        with _open_trusted_artifact(path) as stream, Image.open(stream) as image:
            image.load()
            if image.size != (854, 480):
                raise RenderFailure("media-invalid")
    except RenderFailure:
        raise
    except Exception as error:
        raise RenderFailure("media-invalid") from error


def _validate_mp4(path: Path) -> None:
    import av

    try:
        with _open_trusted_artifact(path) as stream, av.open(stream, mode="r", format="mp4") as container:
            streams = list(container.streams)
            if (
                "mp4" not in container.format.name.split(",")
                or len(streams) != 1
                or streams[0].type != "video"
                or streams[0].codec_context.name != "h264"
                or streams[0].codec_context.format is None
                or streams[0].codec_context.format.name != "yuv420p"
                or streams[0].width != 854
                or streams[0].height != 480
                or streams[0].average_rate != Fraction(15, 1)
                or streams[0].duration is None
                or streams[0].time_base is None
                or streams[0].duration * streams[0].time_base <= 0
                or streams[0].duration * streams[0].time_base > MAX_VIDEO_DURATION_SECONDS
                or container.duration is None
                or container.duration <= 0
                or container.duration > MAX_VIDEO_DURATION_SECONDS * av.time_base
            ):
                raise RenderFailure("media-invalid")
            frame_count = 0
            previous_pts: int | None = None
            for frame in container.decode(video=0):
                if (
                    frame.width != 854
                    or frame.height != 480
                    or frame.format.name != "yuv420p"
                    or frame.pts is None
                    or (previous_pts is not None and frame.pts <= previous_pts)
                ):
                    raise RenderFailure("media-invalid")
                previous_pts = frame.pts
                frame_count += 1
                if frame_count > 15 * MAX_VIDEO_DURATION_SECONDS:
                    raise RenderFailure("media-invalid")
            if frame_count == 0:
                raise RenderFailure("media-invalid")
    except RenderFailure:
        raise
    except Exception as error:
        raise RenderFailure("media-invalid") from error


def _validate_artifact(path: Path, media_type: str) -> None:
    if media_type == "image/png":
        _validate_png(path)
    elif media_type == "video/mp4":
        _validate_mp4(path)
    else:
        raise RenderFailure("media-invalid")


def _write_project_png(project_png: bytes | None) -> None:
    if project_png is None:
        return
    descriptor = os.open(PROJECT_PNG_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        stream = os.fdopen(descriptor, "wb", closefd=True)
        descriptor = -1
        with stream:
            stream.write(project_png)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise


def _render(source: str, scene_name: str, kind: str, project_png: bytes | None) -> tuple[Path, str]:
    SOURCE_PATH.write_text(source, encoding="utf-8")
    _write_project_png(project_png)
    arguments = [
        "/opt/venv/bin/manim",
        "-ql",
        "--resolution",
        "854,480",
        "--fps",
        "15",
        "--disable_caching",
        "--media_dir",
        str(MEDIA_ROOT),
    ]
    if kind == "thumbnail":
        arguments.extend(("-s", "--output_file", "poietra-thumbnail"))
    else:
        arguments.extend(("--output_file", "poietra-render"))
    arguments.extend((str(SOURCE_PATH), scene_name))
    result = subprocess.run(
        arguments,
        check=False,
        cwd=RUNTIME_ROOT / "tmp",
        env=TARGET_ENVIRONMENT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise RenderFailure("manim-exit")
    file_name = "poietra-thumbnail.png" if kind == "thumbnail" else "poietra-render.mp4"
    return _one_rendered_file(file_name), "image/png" if kind == "thumbnail" else "video/mp4"


def _descendant_pids() -> list[int]:
    return sorted(
        int(entry.name)
        for entry in Path("/proc").iterdir()
        if entry.name.isdecimal() and entry.name != "1"
    )


def _reap_children() -> None:
    while True:
        try:
            child, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if child == 0:
            return


def _quiesce_untrusted_descendants() -> None:
    deadline = time.monotonic() + 5.0
    while True:
        _reap_children()
        descendants = _descendant_pids()
        if not descendants:
            _reap_children()
            if not _descendant_pids():
                return
        for process_id in descendants:
            try:
                os.kill(process_id, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Untrusted render descendants could not be reaped.")
        time.sleep(0.01)


def _reset_output_root() -> None:
    try:
        OUTPUT_ROOT.lstat()
    except FileNotFoundError:
        pass
    else:
        quarantine = RUNTIME_ROOT / f".untrusted-output-{os.urandom(16).hex()}"
        OUTPUT_ROOT.rename(quarantine)
    OUTPUT_ROOT.mkdir(mode=0o700)
    status = OUTPUT_ROOT.stat(follow_symlinks=False)
    if OUTPUT_ROOT.is_symlink() or status.st_uid != os.getuid() or status.st_mode & 0o077:
        raise RuntimeError("The trusted output root could not be restored.")


def _copy_artifact(source: Path, media_type: str) -> None:
    suffix = ".png" if media_type == "image/png" else ".mp4"
    artifact = OUTPUT_ROOT / f"artifact{suffix}"
    try:
        shutil.copyfile(source, artifact)
        with artifact.open("rb") as stream:
            os.fsync(stream.fileno())
    except OSError as error:
        raise RenderFailure("artifact-copy") from error


def _enter_broker_readable_state() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    )
    prctl.restype = ctypes.c_int
    if prctl(15, READY_PROCESS_NAME, 0, 0, 0) != 0:
        raise RuntimeError("PID 1 could not enter the broker-readable state.")


def _hold_for_broker() -> None:
    while True:
        time.sleep(3600)


def main() -> None:
    command = tuple(
        part.decode("utf-8")
        for part in Path("/proc/self/cmdline").read_bytes().split(b"\0")
        if part
    )
    if command != TARGET or tuple(sys.argv) != (TARGET[1],):
        raise RuntimeError("The OCI target command is not image-owned.")
    os.umask(0o077)
    _private_runtime()
    _runtime_confinement()
    os.write(2, READY)
    request, execution_digest = _sealed_request()
    source, scene_name, kind, project_png = _validated_request(request)
    rendered: tuple[Path, str] | None = None
    terminal: dict[str, object]
    try:
        rendered = _render(source, scene_name, kind, project_png)
        terminal = {"kind": "ready", "mediaType": rendered[1]}
    except RenderFailure as error:
        terminal = {"code": "render-failed", "kind": "failed", "reason": error.reason}
    except Exception:  # noqa: BLE001 - the untrusted renderer has a fixed public failure code
        terminal = {"code": "render-failed", "kind": "failed", "reason": "internal"}
    _quiesce_untrusted_descendants()
    if rendered is not None:
        try:
            _validate_artifact(*rendered)
        except RenderFailure as error:
            rendered = None
            terminal = {"code": "render-failed", "kind": "failed", "reason": error.reason}
    _reset_output_root()
    if rendered is not None:
        try:
            _copy_artifact(*rendered)
        except RenderFailure as error:
            terminal = {"code": "render-failed", "kind": "failed", "reason": error.reason}
    terminal["executionDigest"] = execution_digest
    _write_terminal(terminal)
    _enter_broker_readable_state()
    _hold_for_broker()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - PID 1 must fail closed for every gate error
        os.write(2, b"POIETRA_RENDER_GATE_REJECTED_V1\n")
        raise SystemExit(70)
