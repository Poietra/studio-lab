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
    "6a8369948029b4811a906fdd028542d5e34b11044937544a9870a88d4b9cd93a"
)
EXPECTED_TOOLCHAIN_DIGEST = (
    "9719d236a037e2f6ff263d8940a473521e32c43f02114e41a6dce4e363111825"
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
    response = poietra_mathtex_outline.compile_mathtex_outline_v1([r"\frac{a}{b}"])
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
