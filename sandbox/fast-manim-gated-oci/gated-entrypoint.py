"""Authenticate one bounded request before the fixed snapshot producer starts."""

from __future__ import annotations

import ctypes
import errno
import fcntl
import hashlib
import hmac
import os
import resource
import socket
import struct
import sys
from pathlib import Path


MAGIC = b"POIETR1\x00"
VERSION = 1
HEADER_BYTES = 48
MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 32 * 1024
READY = b"POIETRA_GATE_READY_V1\n"
TARGET = ("/opt/venv/bin/python", "-m", "manim.renderer.scene_snapshot")
RUNTIME_ROOT = Path("/run/poietra")
RUNTIME_DIRECTORIES = ("cache", "config", "data", "home", "tmp")
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
    _sealed_stdin(body)
    os.execve(TARGET[0], TARGET, TARGET_ENVIRONMENT)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        os.write(2, b"POIETRA_GATE_REJECTED_V1\n")
        raise SystemExit(70)
