"""Authenticate one bounded request before the fixed identity producer starts."""

from __future__ import annotations

import base64
import ctypes
import errno
import fcntl
import hashlib
import hmac
import io
import json
import os
import resource
import socket
import stat
import struct
import sys
from pathlib import Path


MAGIC = b"POIETR1\x00"
VERSION = 1
HEADER_BYTES = 48
MAX_LEGACY_REQUEST_BYTES = 2 * 1024 * 1024 + 64 * 1024
MAX_PNG_BYTES = 512 * 1024
MAX_PNG_BASE64_BYTES = 4 * ((MAX_PNG_BYTES + 2) // 3)
MAX_REQUEST_BYTES = MAX_LEGACY_REQUEST_BYTES + MAX_PNG_BASE64_BYTES + 64 * 1024
READY = b"POIETRA_GATE_READY_V1\n"
TARGET = (
    "/opt/venv/bin/python",
    "-m",
    "manim.renderer.source_runtime_identity",
)
RUNTIME_ROOT = Path("/run/poietra")
RUNTIME_DIRECTORIES = ("cache", "config", "data", "home", "tmp")
PROJECT_PNG_PATH = RUNTIME_ROOT / "image.png"
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
    for name in RUNTIME_DIRECTORIES:
        directory = RUNTIME_ROOT / name
        directory.mkdir(mode=0o700)
        status = directory.stat(follow_symlinks=False)
        if directory.is_symlink() or status.st_uid != os.getuid() or status.st_mode & 0o077:
            raise RuntimeError("A runtime directory is not private.")


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
    """Verify the kernel-enforced development profile before opening the gate."""
    if os.getuid() != 65532 or os.getgid() != 65532 or os.getpid() != 1:
        raise RuntimeError("The OCI process identity drifted.")
    status = Path("/proc/self/status").read_text(encoding="utf-8")
    if "CapEff:\t0000000000000000" not in status or "NoNewPrivs:\t1" not in status:
        raise RuntimeError("The OCI privilege boundary drifted.")
    if resource.getrlimit(resource.RLIMIT_NOFILE) != (256, 256):
        raise RuntimeError("The OCI descriptor limit drifted.")
    if resource.getrlimit(resource.RLIMIT_CORE) != (0, 0):
        raise RuntimeError("The OCI core limit drifted.")

    try:
        descriptor = os.open("/opt/poietra/gated-entrypoint.py", os.O_WRONLY | os.O_APPEND)
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
            raise RuntimeError("The read-only root filesystem check was inconclusive.") from error
    else:
        os.close(descriptor)
        raise RuntimeError("The OCI root filesystem is writable.")

    try:
        raw_socket = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EPERM):
            raise RuntimeError("The raw socket check was inconclusive.") from error
    else:
        raw_socket.close()
        raise RuntimeError("The OCI process can open raw sockets.")

    _assert_outbound_network_blocked()

    mount_target = RUNTIME_ROOT / "tmp" / "mount-target"
    mount_target.mkdir(mode=0o700)
    libc = ctypes.CDLL(None, use_errno=True)
    mount = libc.mount
    mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)
    mount.restype = ctypes.c_int
    if mount(b"none", os.fsencode(mount_target), b"tmpfs", 0, None) != -1 or ctypes.get_errno() != errno.EPERM:
        raise RuntimeError("The OCI process can create mounts.")
    # rmdir is intentionally absent from the seccomp profile. The empty probe
    # directory stays inside the bounded private tmpfs handed to the producer.


def _sealed_stdin(body: bytes) -> None:
    descriptor = os.memfd_create("poietra-request", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        view = memoryview(body)
        written = 0
        while written < len(view):
            written += os.write(descriptor, view[written:])
        os.lseek(descriptor, 0, os.SEEK_SET)
        seals = fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, seals)
        os.dup2(descriptor, 0, inheritable=True)
    finally:
        if descriptor != 0:
            os.close(descriptor)


def _validated_project_png(value: object) -> bytes:
    expected = {"byteLength", "bytesBase64", "digest", "height", "logicalPath", "mediaType", "width"}
    if not isinstance(value, dict) or set(value) != expected:
        raise RuntimeError("The snapshot PNG asset shape is invalid.")
    encoded = value.get("bytesBase64")
    byte_length = value.get("byteLength")
    digest = value.get("digest")
    width = value.get("width")
    height = value.get("height")
    if (
        not isinstance(encoded, str)
        or len(encoded) > MAX_PNG_BASE64_BYTES
        or not isinstance(byte_length, int)
        or isinstance(byte_length, bool)
        or byte_length < 1
        or byte_length > MAX_PNG_BYTES
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
        raise RuntimeError("The snapshot PNG asset metadata is invalid.")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise RuntimeError("The snapshot PNG asset encoding is invalid.") from error
    if (
        base64.b64encode(decoded).decode("ascii") != encoded
        or len(decoded) != byte_length
        or not hmac.compare_digest(hashlib.sha256(decoded).hexdigest(), digest)
    ):
        raise RuntimeError("The snapshot PNG asset correlation is invalid.")

    from PIL import Image

    try:
        with Image.open(io.BytesIO(decoded)) as image:
            if image.format != "PNG" or image.size != (width, height) or getattr(image, "n_frames", 1) != 1:
                raise RuntimeError("The snapshot PNG asset metadata is invalid.")
            image.verify()
        with Image.open(io.BytesIO(decoded)) as image:
            image.load()
            if image.size != (width, height) or getattr(image, "n_frames", 1) != 1:
                raise RuntimeError("The snapshot PNG asset changed while decoding.")
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("The snapshot PNG asset is invalid.") from error
    return decoded


def _selection_offers_profile_4(request: object) -> bool:
    if not isinstance(request, dict) or request.get("schema") != (
        "poietra.fast-manim-snapshot-profile-selection-request"
    ):
        return False
    policy = request.get("policy")
    candidates = policy.get("candidates") if isinstance(policy, dict) else None
    return isinstance(candidates, list) and any(
        isinstance(candidate, dict) and candidate.get("snapshotVersion") == 4
        for candidate in candidates
    )


def _validated_request_payload(body: bytes) -> tuple[bytes, bytes | None]:
    try:
        request = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("The authenticated request is not valid JSON.") from error
    if not isinstance(request, dict):
        raise RuntimeError("The authenticated request is not an object.")
    is_envelope = (
        request.get("schema") == "poietra.fast-manim-sandbox-request"
        or request.get("version") in (2, 3)
        or "assets" in request
        or "producerRequest" in request
    )
    if not is_envelope:
        if (
            len(body) > MAX_LEGACY_REQUEST_BYTES
            or request.get("snapshotVersion") == 4
            or _selection_offers_profile_4(request)
        ):
            raise RuntimeError("Producer profile 4 requires the sealed snapshot PNG envelope.")
        return body, None
    if (
        set(request) != {"assets", "producerRequest", "schema", "version"}
        or request.get("schema") != "poietra.fast-manim-sandbox-request"
        or request.get("version") not in (2, 3)
    ):
        raise RuntimeError("The snapshot sandbox envelope shape is invalid.")
    assets = request.get("assets")
    producer_request = request.get("producerRequest")
    version = request.get("version")
    concrete_v4 = (
        version == 2
        and isinstance(producer_request, dict)
        and producer_request.get("snapshotVersion") == 4
        and isinstance(producer_request.get("runtimeConfig"), dict)
        and producer_request["runtimeConfig"].get("snapshotVersion") == 4
    )
    selection_v3 = version == 3 and _selection_offers_profile_4(producer_request)
    if (
        not isinstance(assets, list)
        or len(assets) != 1
        or not isinstance(producer_request, dict)
        or not (concrete_v4 or selection_v3)
    ):
        raise RuntimeError("The snapshot sandbox envelope correlation is invalid.")
    producer_body = json.dumps(
        producer_request,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(producer_body) > MAX_LEGACY_REQUEST_BYTES:
        raise RuntimeError("The embedded producer request exceeds its byte budget.")
    return producer_body, _validated_project_png(assets[0])


def _write_project_png(project_png: bytes | None) -> None:
    if project_png is None:
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(PROJECT_PNG_PATH, flags, 0o600)
    try:
        stream = os.fdopen(descriptor, "wb", closefd=True)
        descriptor = -1
        with stream:
            stream.write(project_png)
            stream.flush()
            os.fsync(stream.fileno())
            status = os.fstat(stream.fileno())
            if not stat.S_ISREG(status.st_mode) or status.st_size != len(project_png):
                raise RuntimeError("The snapshot image.png materialization is not a bounded regular file.")
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def main() -> None:
    if tuple(sys.argv[1:]) != TARGET:
        raise RuntimeError("The OCI target command is not the image-owned command.")
    _private_runtime()
    _runtime_confinement()
    os.write(2, READY)
    stream = sys.stdin.buffer
    header = _read_exact(stream, HEADER_BYTES)
    magic, version, byte_length, expected_digest = struct.unpack(">8sII32s", header)
    if magic != MAGIC or version != VERSION or byte_length > MAX_REQUEST_BYTES:
        raise RuntimeError("The authenticated request header is invalid.")
    body = _read_exact(stream, byte_length)
    if stream.read(1) != b"":
        raise RuntimeError("The authenticated request has trailing bytes.")
    if not hmac.compare_digest(hashlib.sha256(body).digest(), expected_digest):
        raise RuntimeError("The authenticated request digest is invalid.")
    producer_body, project_png = _validated_request_payload(body)
    _write_project_png(project_png)
    _sealed_stdin(producer_body)
    os.execve(TARGET[0], TARGET, TARGET_ENVIRONMENT)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        os.write(2, b"POIETRA_GATE_REJECTED_V1\n")
        raise SystemExit(70)
