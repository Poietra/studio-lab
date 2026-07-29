"""Build-time verification for the pinned native MathTex provider."""

from __future__ import annotations

import importlib.machinery
import json
from pathlib import Path

import poietra_mathtex_outline

EXPECTED_MODULE = Path(
    "/opt/venv/lib/python3.14/site-packages/poietra_mathtex_outline.abi3.so"
)
EXPECTED_FONT_DIGEST = (
    "d66ac1cc91c55c24d3636ae2df1238076debdff51841f9893fc5419cc2df3df7"
)
EXPECTED_TOOLCHAIN_DIGEST = (
    "95c98e10edff239e6ee237c9eac99dc96c06ba9fc712c30816ddc47d7db12f9e"
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    spec = poietra_mathtex_outline.__spec__
    origin = Path(spec.origin).resolve() if spec and spec.origin else None
    require(
        spec is not None
        and isinstance(spec.loader, importlib.machinery.ExtensionFileLoader)
        and origin == EXPECTED_MODULE,
        "The MathTex provider is not the pinned native module.",
    )
    abi_version = poietra_mathtex_outline.abi_version()
    require(
        type(abi_version) is int and abi_version == 1,
        "The MathTex provider ABI drifted.",
    )
    response = poietra_mathtex_outline.compile_mathtex_outline_v1(["E = mc^2"])
    require(
        type(response) is bytes and len(response) <= 1024 * 1024,
        "The MathTex provider response is invalid.",
    )
    document = json.loads(response)
    result = document.get("result", {})
    require(
        document.get("schema") == "poietra.mathtex-outline-response"
        and document.get("version") == 1
        and result.get("kind") == "compiled"
        and result.get("fontDigest") == EXPECTED_FONT_DIGEST
        and result.get("toolchainDigest") == EXPECTED_TOOLCHAIN_DIGEST
        and len(result.get("path", {}).get("subpaths", [])) > 1,
        "The MathTex provider artifact contract drifted.",
    )


if __name__ == "__main__":
    main()
