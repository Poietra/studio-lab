"""Emit the unsigned, canonical package inventory embedded in the OCI image."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import subprocess
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _native_artifacts(root: Path) -> list[dict[str, str]]:
    artifacts = []
    for path in sorted(root.rglob("*"), key=lambda candidate: candidate.relative_to(root).as_posix()):
        if path.is_symlink() or not path.is_file():
            continue
        if not (path.name.endswith(".so") or ".so." in path.name):
            continue
        artifacts.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": _sha256(path),
            }
        )
    return artifacts


def _os_packages() -> list[dict[str, str]]:
    output = subprocess.run(
        ["dpkg-query", "-W", "-f=${Package}\t${Version}\n"],
        check=True,
        env={"PATH": "/usr/bin:/bin"},
        stdout=subprocess.PIPE,
        text=True,
    ).stdout
    return [
        {"name": name, "version": version}
        for name, version in sorted(line.split("\t", 1) for line in output.splitlines())
    ]


def _python_packages() -> list[dict[str, str]]:
    packages = {
        (distribution.metadata["Name"].lower(), distribution.version)
        for distribution in importlib.metadata.distributions()
        if distribution.metadata["Name"]
    }
    return [{"name": name, "version": version} for name, version in sorted(packages)]


def main() -> None:
    venv = Path("/opt/venv")
    document = {
        "artifacts": {"native": _native_artifacts(venv)},
        "build": {
            "fastManimArchiveSha256": os.environ["POIETRA_FAST_MANIM_ARCHIVE_SHA256"],
            "fastManimCommit": os.environ["POIETRA_FAST_MANIM_COMMIT"],
            "fastManimTree": os.environ["POIETRA_FAST_MANIM_TREE"],
            "sourceDateEpoch": int(os.environ["SOURCE_DATE_EPOCH"]),
            "uvLockSha256": os.environ["POIETRA_FAST_MANIM_UV_LOCK_SHA256"],
        },
        "kind": "unsigned-package-inventory",
        "operatingSystem": {"packages": _os_packages()},
        "python": {
            "implementation": platform.python_implementation(),
            "packages": _python_packages(),
            "version": platform.python_version(),
        },
        "schema": "poietra.fast-manim-oci-sbom",
        "signed": False,
        "toolchain": {
            "buildRequirementsSha256": os.environ[
                "POIETRA_BUILD_REQUIREMENTS_SHA256"
            ],
            "debianSnapshot": os.environ["POIETRA_DEBIAN_SNAPSHOT"],
            "pythonImage": os.environ["POIETRA_PYTHON_IMAGE"],
            "pythonPlatformManifestDigest": os.environ[
                "POIETRA_PYTHON_PLATFORM_MANIFEST_DIGEST"
            ],
            "uvImage": os.environ["POIETRA_UV_IMAGE"],
            "uvPlatformManifestDigest": os.environ[
                "POIETRA_UV_PLATFORM_MANIFEST_DIGEST"
            ],
        },
        "version": 1,
    }
    encoded = json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    output = Path("/opt/poietra/sbom.v1.json")
    output.write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
