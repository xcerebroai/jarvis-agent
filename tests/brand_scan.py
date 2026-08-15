#!/usr/bin/env python3
"""brand_scan.py — tree-wide brand-leak scan of a POST-APPLY Hermes checkout.

WHY THIS EXISTS
---------------
apply.sh brands a *curated list* of files, and its verify pass re-scans that
same curated list. That is circular: a brand string in a file nobody thought to
add is invisible to both. Upstream v0.20.1 shipped hermes_cli/_startup_fast.py,
which reprinted the version banner; `hermes --version` went back to saying
"Hermes Agent" and the verify pass still reported "no visible brand strings
survived", because the new file was in neither list.

This scanner walks the whole tree instead of a list, so a new upstream file
carrying the brand fails the build the day it lands. Every known-good hit must
be justified in branding-known-ok.txt — the allowlist is the only escape hatch,
and each entry carries a reason.

WHAT COUNTS AS A HIT
--------------------
Only *string literals* — code that can reach a user. Comments and docstrings
are excluded: they are developer-facing, they are upstream's to write, and
rewriting them would create pointless merge conflicts on every pull.

  .py   parsed with ast; docstrings identified structurally and skipped.
  other line scan with comment prefixes stripped (best-effort).

Usage:
  python3 tests/brand_scan.py [SRC]            # SRC defaults to $HERMES_SRC or .
  python3 tests/brand_scan.py --list           # print every hit, ignore allowlist
Exit 0 = clean (or every hit allowlisted), 1 = unaccounted leak, 2 = bad usage.
"""
from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

# Windows consoles default to cp1252, which cannot encode the box glyphs this
# script prints (or the ones it finds in upstream's banners). Never let an
# encoding error be mistaken for a scan failure.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - old/odd streams
        pass

# The brand phrases a customer would recognise. Deliberately NOT bare "Hermes":
# that appears in paths (~/.hermes), identifiers (hermes_cli, HERMES_HOME) and
# the Nous model family (Hermes 3 & 4), none of which we rewrite.
NEEDLES = ("Hermes Agent", "HERMES AGENT")

# Directories with no customer-visible output: vendored code, build output,
# and upstream's own test suites (fixtures legitimately assert on upstream
# strings; rebranding them would break upstream's tests, not our branding).
SKIP_DIRS = {
    ".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build",
    "release", "target", "site-packages", ".pytest_cache", ".mypy_cache",
    "tests", "test", "e2e", "__tests__", "website", "docs",
}
SKIP_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".test.py")
TEXT_EXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".yaml", ".yml", ".html", ".json"}

ALLOWLIST_NAME = "branding-known-ok.txt"


def load_allowlist(path: Path) -> list[tuple[str, str]]:
    """Entries are `<path-suffix><TAB><needle>`; blank/# lines are comments."""
    out: list[tuple[str, str]] = []
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" not in line:
            print(f"  ! malformed allowlist line (needs a TAB): {line}", file=sys.stderr)
            continue
        f, needle = line.split("\t", 1)
        out.append((f.strip().replace("\\", "/"), needle.strip()))
    return out


def allowed(rel: str, text: str, entries: list[tuple[str, str]]) -> bool:
    for f, needle in entries:
        if rel.endswith(f) and needle in text:
            return True
    return False


def walk(src: Path):
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            p = Path(root) / name
            if p.suffix not in TEXT_EXT or name.endswith(SKIP_SUFFIXES):
                continue
            yield p


def scan_python(p: Path, src_text: str):
    """Yield (lineno, literal) for non-docstring string constants."""
    try:
        tree = ast.parse(src_text)
    except SyntaxError:
        return
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if ast.get_docstring(node, clean=False) is not None:
                if node.body and isinstance(node.body[0], ast.Expr):
                    docstrings.add(id(node.body[0].value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) in docstrings:
                continue
            if any(n in node.value for n in NEEDLES):
                yield node.lineno, node.value


def strip_comment(line: str, ext: str) -> str:
    """Best-effort comment removal for non-Python text formats."""
    if ext in (".yaml", ".yml"):
        # A '#' inside quotes is not a comment; only strip when clearly leading.
        stripped = line.lstrip()
        return "" if stripped.startswith("#") else line
    if ext in (".ts", ".tsx", ".js", ".jsx"):
        stripped = line.lstrip()
        if stripped.startswith(("//", "*", "/*")):
            return ""
    if ext == ".html":
        stripped = line.lstrip()
        if stripped.startswith("<!--"):
            return ""
    return line


def scan_text(p: Path, src_text: str):
    ext = p.suffix
    for i, line in enumerate(src_text.splitlines(), 1):
        cleaned = strip_comment(line, ext)
        if any(n in cleaned for n in NEEDLES):
            yield i, line.strip()


def main(argv: list[str]) -> int:
    list_mode = "--list" in argv
    args = [a for a in argv[1:] if not a.startswith("-")]
    src = Path(args[0] if args else os.environ.get("HERMES_SRC") or ".").resolve()
    if not src.is_dir():
        print(f"brand_scan: not a directory: {src}", file=sys.stderr)
        return 2

    overlay = Path(__file__).resolve().parent.parent
    entries = load_allowlist(overlay / ALLOWLIST_NAME)

    hits, skipped = [], 0
    for p in walk(src):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not any(n in text for n in NEEDLES):
            continue
        finder = scan_python if p.suffix == ".py" else scan_text
        for lineno, literal in finder(p, text):
            rel = p.relative_to(src).as_posix()
            if not list_mode and allowed(rel, literal, entries):
                skipped += 1
                continue
            hits.append((rel, lineno, " ".join(literal.split())[:110]))

    print(f"◆ brand scan — {src}")
    print(f"  allowlist: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}"
          f" ({skipped} hit(s) matched)")
    if hits:
        print(f"  ✗ {len(hits)} unaccounted brand string(s):\n")
        for rel, lineno, literal in sorted(hits):
            print(f"    {rel}:{lineno}\n        {literal}")
        print(
            "\n  Each of these reaches a user, or needs a line in "
            f"{ALLOWLIST_NAME} saying why it does not.\n"
            "  Brand it: add the file to the curated list in apply.sh.\n"
            "  Or allowlist it: add '<path>\\t<needle>' plus a reason comment."
        )
        return 1
    print("  ✓ no unaccounted brand strings in the whole tree")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
