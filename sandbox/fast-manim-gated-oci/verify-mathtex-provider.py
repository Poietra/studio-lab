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
    "e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa"
)
EXPECTED_TOOLCHAIN_DIGEST = (
    "40a85bd625fe868b295906a6a002a1cfae677be241f835898f467a113b626430"
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
