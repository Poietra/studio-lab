"""Unit coverage for the fixed PNG snapshot sandbox envelope."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


def _load_entrypoint(path: str) -> object:
    spec = importlib.util.spec_from_file_location("poietra_gate", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the gated entrypoint.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATE = _load_entrypoint(sys.argv.pop(1))
STATIC_PNG = Path(sys.argv.pop(1)).read_bytes()


def _asset(data: bytes) -> dict[str, object]:
    with Image.open(io.BytesIO(data)) as image:
        width, height = image.size
    return {
        "byteLength": len(data),
        "bytesBase64": base64.b64encode(data).decode("ascii"),
        "digest": hashlib.sha256(data).hexdigest(),
        "height": height,
        "logicalPath": "image.png",
        "mediaType": "image/png",
        "width": width,
    }


def _envelope(asset: dict[str, object] | None) -> bytes:
    return json.dumps(
        {
            "assets": [] if asset is None else [asset],
            "producerRequest": {"runtimeConfig": {"snapshotVersion": 4}, "snapshotVersion": 4},
            "schema": "poietra.fast-manim-sandbox-request",
            "version": 2,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


class GatedEntrypointPngTest(unittest.TestCase):
    def test_extracts_one_verified_png_without_exposing_it_to_producer_json(self) -> None:
        producer_body, png = GATE._validated_request_payload(_envelope(_asset(STATIC_PNG)))
        self.assertEqual(png, STATIC_PNG)
        self.assertEqual(
            json.loads(producer_body),
            {"runtimeConfig": {"snapshotVersion": 4}, "snapshotVersion": 4},
        )
        self.assertNotIn(b"bytesBase64", producer_body)

    def test_preserves_legacy_bytes_and_rejects_unenveloped_profile_4(self) -> None:
        legacy = b'{"snapshotVersion":3}'
        self.assertEqual(GATE._validated_request_payload(legacy), (legacy, None))
        with self.assertRaises(RuntimeError):
            GATE._validated_request_payload(b'{"snapshotVersion":4}')

    def test_rejects_missing_mismatched_oversized_and_animated_png(self) -> None:
        with self.assertRaises(RuntimeError):
            GATE._validated_request_payload(_envelope(None))

        mismatched = _asset(STATIC_PNG)
        mismatched["digest"] = "0" * 64
        with self.assertRaises(RuntimeError):
            GATE._validated_request_payload(_envelope(mismatched))

        oversized = _asset(STATIC_PNG)
        oversized["byteLength"] = GATE.MAX_PNG_BYTES + 1
        with self.assertRaises(RuntimeError):
            GATE._validated_request_payload(_envelope(oversized))

        animated_stream = io.BytesIO()
        first = Image.new("RGBA", (1, 1), (255, 0, 0, 255))
        second = Image.new("RGBA", (1, 1), (0, 0, 255, 255))
        first.save(animated_stream, format="PNG", save_all=True, append_images=[second], duration=10)
        with self.assertRaises(RuntimeError):
            GATE._validated_request_payload(_envelope(_asset(animated_stream.getvalue())))

    def test_materializes_mode_600_and_refuses_an_existing_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "image.png"
            GATE.PROJECT_PNG_PATH = output
            GATE._write_project_png(STATIC_PNG)
            self.assertEqual(output.read_bytes(), STATIC_PNG)
            self.assertEqual(stat.S_IMODE(output.stat(follow_symlinks=False).st_mode), 0o600)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside.png"
            outside.write_bytes(b"unchanged")
            link = root / "image.png"
            link.symlink_to(outside)
            GATE.PROJECT_PNG_PATH = link
            with self.assertRaises(OSError):
                GATE._write_project_png(STATIC_PNG)
            self.assertEqual(outside.read_bytes(), b"unchanged")


if __name__ == "__main__":
    unittest.main()
