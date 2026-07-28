"""Validate the fixed runtime contract and supervise its single trusted tool."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path


RUNTIME_ROOT = Path("/run/poietra")
RUNTIME_DIRECTORIES = ("cache", "config", "data", "home", "tmp")
PROFILE_PATH = Path("/opt/poietra/profile.v1.json")
ASSET_ROOT = Path("/opt/poietra/assets")
ASSET_CONTROL_FILE = ".poietra-assets.v1.json"
ASSET_MANIFEST_SCHEMA = "poietra.fast-manim-oci-asset-manifest"
MAXIMUM_MANIFEST_BYTES = 32 * 1024
SHA256_NAME = re.compile(r"^[a-f0-9]{64}$")
PR_SET_DUMPABLE = 4


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _runtime_contract() -> tuple[list[str], dict[str, str], dict[str, object]]:
    encoded = PROFILE_PATH.read_bytes()
    if len(encoded) > 16 * 1024:
        raise RuntimeError("The embedded sandbox profile exceeds its byte budget.")
    profile = json.loads(encoded)
    target = profile.get("process", {}).get("target")
    environment = profile.get("environment")
    assets = profile.get("assets")
    if (
        type(target) is not list
        or not target
        or any(type(entry) is not str or not entry for entry in target)
        or type(environment) is not dict
        or not environment
        or type(assets) is not dict
        or any(
            type(key) is not str
            or type(value) is not str
            or not key
            or "=" in key
            or "\x00" in key
            or "\x00" in value
            for key, value in environment.items()
        )
    ):
        raise RuntimeError("The embedded sandbox runtime contract is malformed.")
    return target, environment, assets


def _verify_assets(contract: dict[str, object]) -> None:
    maximum_assets = contract.get("maximumAssets")
    maximum_asset_bytes = contract.get("maximumAssetBytes")
    maximum_total_bytes = contract.get("maximumTotalAssetBytes")
    if (
        contract.get("controlFile") != ASSET_CONTROL_FILE
        or contract.get("destinationRoot") != str(ASSET_ROOT)
        or contract.get("injection") != "digest-verified-read-only-request-volume"
        or contract.get("manifestSchema") != ASSET_MANIFEST_SCHEMA
        or contract.get("readOnlyAtExecution") is not True
        or type(maximum_assets) is not int
        or type(maximum_asset_bytes) is not int
        or type(maximum_total_bytes) is not int
        or maximum_assets != 64
        or maximum_asset_bytes != 16 * 1024 * 1024
        or maximum_total_bytes != 16 * 1024 * 1024
    ):
        raise RuntimeError("The embedded asset contract is malformed.")
    root_status = ASSET_ROOT.lstat()
    if (
        not stat.S_ISDIR(root_status.st_mode)
        or stat.S_IMODE(root_status.st_mode) != 0o555
        or root_status.st_uid != 0
        or root_status.st_gid != 0
    ):
        raise RuntimeError("The immutable asset root metadata is invalid.")
    control_path = ASSET_ROOT / ASSET_CONTROL_FILE
    control_status = control_path.lstat()
    if (
        not stat.S_ISREG(control_status.st_mode)
        or control_status.st_nlink != 1
        or stat.S_IMODE(control_status.st_mode) != 0o444
        or control_status.st_uid != 0
        or control_status.st_gid != 0
        or control_status.st_size <= 0
        or control_status.st_size > MAXIMUM_MANIFEST_BYTES
    ):
        raise RuntimeError("The immutable asset manifest metadata is invalid.")
    encoded_manifest = control_path.read_bytes()
    manifest = json.loads(encoded_manifest, object_pairs_hook=_reject_duplicate_keys)
    if (
        type(manifest) is not dict
        or set(manifest) != {"assets", "count", "schema", "version"}
        or manifest.get("schema") != ASSET_MANIFEST_SCHEMA
        or manifest.get("version") != 1
        or type(manifest.get("count")) is not int
        or type(manifest.get("assets")) is not list
        or manifest["count"] != len(manifest["assets"])
        or manifest["count"] > maximum_assets
        or _canonical_json(manifest) != encoded_manifest
    ):
        raise RuntimeError("The immutable asset manifest contract is invalid.")
    expected_assets: dict[str, int] = {}
    previous_name = ""
    for descriptor in manifest["assets"]:
        if type(descriptor) is not dict or set(descriptor) != {"byteLength", "fileName", "sha256"}:
            raise RuntimeError("The immutable asset manifest descriptor is invalid.")
        name = descriptor["fileName"]
        byte_length = descriptor["byteLength"]
        if (
            type(name) is not str
            or SHA256_NAME.fullmatch(name) is None
            or descriptor["sha256"] != name
            or name <= previous_name
            or type(byte_length) is not int
            or byte_length < 0
            or byte_length > maximum_asset_bytes
        ):
            raise RuntimeError("The immutable asset manifest descriptor violates the locked contract.")
        expected_assets[name] = byte_length
        previous_name = name
    paths = sorted(ASSET_ROOT.iterdir(), key=lambda path: path.name)
    if {path.name for path in paths} != {ASSET_CONTROL_FILE, *expected_assets}:
        raise RuntimeError("The immutable asset volume has missing or unexpected paths.")
    total_bytes = 0
    for name, expected_length in expected_assets.items():
        path = ASSET_ROOT / name
        status = path.lstat()
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_nlink != 1
            or stat.S_IMODE(status.st_mode) != 0o444
            or status.st_uid != 0
            or status.st_gid != 0
            or status.st_size != expected_length
        ):
            raise RuntimeError("Immutable asset metadata violates the locked contract.")
        total_bytes += status.st_size
        if total_bytes > maximum_total_bytes:
            raise RuntimeError("Immutable assets exceed their cumulative byte budget.")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != name:
            raise RuntimeError("Immutable asset bytes do not match their digest filename.")


def _supervise_target(target: list[str], environment: dict[str, str]) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))

    temporary_root = RUNTIME_ROOT / "tmp"
    with (
        tempfile.TemporaryFile(dir=temporary_root) as stdout_capture,
        tempfile.TemporaryFile(dir=temporary_root) as stderr_capture,
    ):
        child_pid = os.posix_spawn(
            target[0],
            target,
            environment,
            file_actions=(
                (os.POSIX_SPAWN_DUP2, stdout_capture.fileno(), sys.stdout.fileno()),
                (os.POSIX_SPAWN_DUP2, stderr_capture.fileno(), sys.stderr.fileno()),
            ),
        )
        _, wait_status = os.waitpid(child_pid, 0)
        return_code = os.waitstatus_to_exitcode(wait_status)
        stderr_capture.seek(0)
        shutil.copyfileobj(stderr_capture, sys.stderr.buffer)
        sys.stderr.buffer.flush()
        if return_code == 0:
            stdout_capture.seek(0)
            shutil.copyfileobj(stdout_capture, sys.stdout.buffer)
            sys.stdout.buffer.flush()
        return return_code


def main() -> None:
    target, environment, assets = _runtime_contract()
    if sys.argv[1:] != target:
        raise RuntimeError("The sandbox target command does not match the fixed profile.")
    if RUNTIME_ROOT.resolve() != RUNTIME_ROOT:
        raise RuntimeError("The request runtime root is not canonical.")
    for name in RUNTIME_DIRECTORIES:
        directory = RUNTIME_ROOT / name
        directory.mkdir(mode=0o700)
        if directory.is_symlink() or directory.stat().st_uid != os.getuid():
            raise RuntimeError("The request runtime directory is not privately owned.")
    _verify_assets(assets)
    raise SystemExit(_supervise_target(target, environment))


if __name__ == "__main__":
    main()
