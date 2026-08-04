#!/usr/bin/env python3
"""Verify the checked-in literal MathTex call-site census against fast-manim."""

from __future__ import annotations

import argparse
import ast
from collections import Counter
import json
from pathlib import Path
import subprocess
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURE = REPOSITORY_ROOT / "fixtures/mathtex-v1/fast-manim-callsite-corpus.json"
SEARCH_ROOTS = ("example_scenes", "tests", "manim")


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()


def call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def literal_tex_parts(call: ast.Call) -> list[str] | None:
    parts: list[str] = []
    for argument in call.args:
        if (
            not isinstance(argument, ast.Constant)
            or isinstance(argument.value, bool)
            or not isinstance(argument.value, (str, int, float))
        ):
            return None
        parts.append(str(argument.value))
    return parts or None


def extract_callsites(repository: Path) -> list[dict[str, Any]]:
    extracted: list[tuple[str, int, int, list[str]]] = []
    tracked_sources = sorted(
        path
        for path in git(repository, "ls-files", "--", *SEARCH_ROOTS).splitlines()
        if path.endswith(".py")
    )
    for relative_path in tracked_sources:
        source_path = repository / relative_path
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or call_name(node) != "MathTex":
                continue
            if any(keyword.arg == "tex_template" for keyword in node.keywords):
                continue
            tex_parts = literal_tex_parts(node)
            if tex_parts is None:
                continue
            extracted.append(
                (
                    relative_path,
                    node.lineno,
                    node.col_offset,
                    tex_parts,
                )
            )
    extracted.sort(key=lambda callsite: (callsite[0], callsite[1], callsite[2], callsite[3]))
    return [
        {"provenance": f"{path}:{line}", "texParts": tex_parts}
        for path, line, _column, tex_parts in extracted
    ]


def callsite_key(callsite: dict[str, Any]) -> tuple[str, tuple[str, ...]]:
    return callsite["provenance"], tuple(callsite["texParts"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    arguments = parser.parse_args()

    repository = arguments.repository.resolve()
    fixture_path = arguments.fixture.resolve()
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    source_commit = git(repository, "rev-parse", "HEAD")
    if source_commit != fixture["sourceCommit"]:
        raise SystemExit(
            f"fast-manim HEAD {source_commit} does not match pinned sourceCommit "
            f"{fixture['sourceCommit']}"
        )
    if git(repository, "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("fast-manim has tracked working-tree changes; census would not be reproducible")

    extracted = extract_callsites(repository)
    expected = [
        {"provenance": case["provenance"], "texParts": case["texParts"]}
        for case in fixture["cases"]
    ]
    extracted_counts = Counter(callsite_key(callsite) for callsite in extracted)
    expected_counts = Counter(callsite_key(callsite) for callsite in expected)
    if extracted_counts != expected_counts:
        missing = list((expected_counts - extracted_counts).elements())
        unexpected = list((extracted_counts - expected_counts).elements())
        raise SystemExit(
            "fast-manim MathTex call-site census drifted:\n"
            f"missing={missing!r}\n"
            f"unexpected={unexpected!r}"
        )

    print(
        json.dumps(
            {
                "cases": len(extracted),
                "fixture": str(fixture_path),
                "sourceCommit": source_commit,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
