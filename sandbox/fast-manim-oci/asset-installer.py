"""Install one canonical, digest-addressed asset archive into a request volume."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path


ASSET_ROOT = Path("/opt/poietra/assets")
CONTROL_FILE = ".poietra-assets.v1.json"
MANIFEST_SCHEMA = "poietra.fast-manim-oci-asset-manifest"
MAXIMUM_ASSETS = 64
MAXIMUM_ASSET_BYTES = 16 * 1024 * 1024
MAXIMUM_TOTAL_ASSET_BYTES = 16 * 1024 * 1024
MAXIMUM_MANIFEST_BYTES = 32 * 1024
SHA256_NAME = re.compile(r"^[a-f0-9]{64}$")


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _read_exact(length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise ValueError("truncated archive")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _write_octal(header: bytearray, offset: int, length: int, value: int) -> None:
    encoded = f"{value:0{length - 1}o}".encode("ascii")
    if len(encoded) != length - 1:
        raise ValueError("ustar field overflow")
    header[offset : offset + length - 1] = encoded
    header[offset + length - 1] = 0


def _canonical_header(name: str, length: int) -> bytes:
    encoded_name = name.encode("ascii")
    if not encoded_name or len(encoded_name) > 100:
        raise ValueError("invalid ustar name")
    header = bytearray(512)
    header[: len(encoded_name)] = encoded_name
    _write_octal(header, 100, 8, 0o444)
    _write_octal(header, 108, 8, 0)
    _write_octal(header, 116, 8, 0)
    _write_octal(header, 124, 12, length)
    _write_octal(header, 136, 12, 0)
    header[148:156] = b" " * 8
    header[156] = ord("0")
    header[257:263] = b"ustar\0"
    header[263:265] = b"00"
    checksum = sum(header)
    header[148:154] = f"{checksum:06o}".encode("ascii")
    header[154] = 0
    header[155] = 0x20
    return bytes(header)


def _parse_manifest(encoded: bytes) -> tuple[dict[str, object], list[dict[str, object]]]:
    if not encoded or len(encoded) > MAXIMUM_MANIFEST_BYTES:
        raise ValueError("manifest byte budget")
    manifest = json.loads(encoded, object_pairs_hook=_reject_duplicate_keys)
    if type(manifest) is not dict or set(manifest) != {"assets", "count", "schema", "version"}:
        raise ValueError("manifest shape")
    assets = manifest["assets"]
    if (
        manifest["schema"] != MANIFEST_SCHEMA
        or manifest["version"] != 1
        or type(manifest["count"]) is not int
        or type(assets) is not list
        or manifest["count"] != len(assets)
        or len(assets) > MAXIMUM_ASSETS
        or _canonical_json(manifest) != encoded
    ):
        raise ValueError("manifest contract")
    previous_name = ""
    total_bytes = 0
    for asset in assets:
        if type(asset) is not dict or set(asset) != {"byteLength", "fileName", "sha256"}:
            raise ValueError("asset manifest shape")
        name = asset["fileName"]
        byte_length = asset["byteLength"]
        if (
            type(name) is not str
            or SHA256_NAME.fullmatch(name) is None
            or asset["sha256"] != name
            or name <= previous_name
            or type(byte_length) is not int
            or byte_length < 0
            or byte_length > MAXIMUM_ASSET_BYTES
        ):
            raise ValueError("asset manifest contract")
        previous_name = name
        total_bytes += byte_length
        if total_bytes > MAXIMUM_TOTAL_ASSET_BYTES:
            raise ValueError("asset cumulative byte budget")
    return manifest, assets


def _write_asset(root_fd: int, expected: dict[str, object], header: bytes) -> None:
    name = expected["fileName"]
    byte_length = expected["byteLength"]
    if type(name) is not str or type(byte_length) is not int or header != _canonical_header(name, byte_length):
        raise ValueError("asset archive header")
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o444,
        dir_fd=root_fd,
    )
    digest = hashlib.sha256()
    try:
        remaining = byte_length
        while remaining:
            chunk = _read_exact(min(1024 * 1024, remaining))
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short asset write")
                view = view[written:]
            remaining -= len(chunk)
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o444)
    finally:
        os.close(descriptor)
    padding = (512 - (byte_length % 512)) % 512
    if padding and _read_exact(padding) != bytes(padding):
        raise ValueError("nonzero archive padding")
    if digest.hexdigest() != name:
        raise ValueError("asset digest mismatch")


def _verify_installed(root_fd: int, manifest_bytes: bytes, assets: list[dict[str, object]]) -> None:
    expected_names = [CONTROL_FILE, *(asset["fileName"] for asset in assets)]
    if sorted(os.listdir(root_fd)) != sorted(expected_names):
        raise ValueError("installed asset set mismatch")
    total_bytes = 0
    for expected in assets:
        name = expected["fileName"]
        if type(name) is not str:
            raise ValueError("invalid installed name")
        status = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_nlink != 1
            or stat.S_IMODE(status.st_mode) != 0o444
            or status.st_uid != 0
            or status.st_gid != 0
            or status.st_size != expected["byteLength"]
        ):
            raise ValueError("installed asset metadata")
        total_bytes += status.st_size
    if total_bytes > MAXIMUM_TOTAL_ASSET_BYTES:
        raise ValueError("installed cumulative byte budget")
    control_status = os.stat(CONTROL_FILE, dir_fd=root_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(control_status.st_mode)
        or control_status.st_nlink != 1
        or stat.S_IMODE(control_status.st_mode) != 0o444
        or control_status.st_uid != 0
        or control_status.st_gid != 0
        or control_status.st_size != len(manifest_bytes)
    ):
        raise ValueError("installed manifest metadata")


def main() -> None:
    groups = os.getgroups()
    if os.getuid() != 0 or os.getgid() != 0 or len(groups) > 1 or any(group != 0 for group in groups):
        raise RuntimeError("installer identity")
    root_status = ASSET_ROOT.lstat()
    if not stat.S_ISDIR(root_status.st_mode) or root_status.st_uid != 0 or root_status.st_gid != 0:
        raise RuntimeError("asset volume root metadata")
    root_fd = os.open(ASSET_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        if os.listdir(root_fd):
            raise RuntimeError("asset volume is not empty")
        os.fchmod(root_fd, 0o700)
        manifest_header = _read_exact(512)
        manifest_length_field = manifest_header[124:136].rstrip(b"\0")
        if not manifest_length_field or any(byte not in b"01234567" for byte in manifest_length_field):
            raise ValueError("manifest archive length")
        manifest_length = int(manifest_length_field, 8)
        if manifest_length <= 0 or manifest_length > MAXIMUM_MANIFEST_BYTES:
            raise ValueError("manifest archive byte budget")
        if manifest_header != _canonical_header(CONTROL_FILE, manifest_length):
            raise ValueError("manifest archive header")
        manifest_bytes = _read_exact(manifest_length)
        padding = (512 - (manifest_length % 512)) % 512
        if padding and _read_exact(padding) != bytes(padding):
            raise ValueError("nonzero manifest padding")
        _, assets = _parse_manifest(manifest_bytes)
        control_fd = os.open(
            CONTROL_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o444,
            dir_fd=root_fd,
        )
        try:
            view = memoryview(manifest_bytes)
            while view:
                written = os.write(control_fd, view)
                if written <= 0:
                    raise OSError("short manifest write")
                view = view[written:]
            os.fsync(control_fd)
            os.fchmod(control_fd, 0o444)
        finally:
            os.close(control_fd)
        for expected in assets:
            _write_asset(root_fd, expected, _read_exact(512))
        if _read_exact(1024) != bytes(1024) or sys.stdin.buffer.read(1) != b"":
            raise ValueError("archive terminator")
        _verify_installed(root_fd, manifest_bytes, assets)
        os.fchmod(root_fd, 0o555)
        os.fsync(root_fd)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Asset installer rejected the closed request archive.", file=sys.stderr)
        raise SystemExit(1)
