#!/usr/bin/env python3
"""
Patch topjohnwu/libcxx's __bit/countr.h and __bit/countl.h so they build with
the Clang shipped in NDK 28.2.13676358 (Clang 19).

Background
----------
libcxx was recently updated to a newer AOSP libc++ snapshot that implements
std::__countr_zero / std::__countl_zero using the *generic* two-argument
builtins __builtin_ctzg(value, fallback_if_zero) / __builtin_clzg(...).
Those generic builtins are only understood by newer Clang releases; NDK
28.2.13676358 ships Clang 19, which doesn't have them yet, so any build that
pulls in <algorithm> (e.g. via std::sort, indirectly used through std::string
in isolation_policy.cpp) fails with:

    error: use of undeclared identifier '__builtin_ctzg'
    error: use of undeclared identifier '__builtin_clzg'

Fix
---
Rewrite the two one-line generic-builtin calls to the classic, always-available
per-width builtins (__builtin_ctz/ctzl/ctzll, __builtin_clz/clzl/clzll), which
is exactly how libc++ implemented these functions before the generic-builtin
migration. Unlike the classic builtins, the generic ones also define the
zero-input case (returning the given fallback instead of UB), so the patch
adds that check explicitly.

Usage
-----
    python3 scripts/patch_libcxx_builtins.py [path/to/libcxx/include]

Defaults to module/jni/libcxx/include relative to the repo root. Idempotent:
running it again on an already-patched file is a no-op.
"""

import re
import sys
from pathlib import Path

# (relative path under <include>/__bit/, generic builtin name, classic builtin base)
TARGETS = [
    ("countr.h", "__builtin_ctzg", "__builtin_ctz"),
    ("countl.h", "__builtin_clzg", "__builtin_clz"),
]

# Matches e.g.:  return __builtin_ctzg(__t, numeric_limits<_Tp>::digits);
# Captures the value expression and the zero-fallback expression so the
# replacement works even if variable names/whitespace differ slightly.
CALL_RE = re.compile(
    r"return\s+(__builtin_[cC][tl]zg)\s*\(\s*([^,]+?)\s*,\s*(.+?)\s*\)\s*;"
)

MARKER = "// patched-for-ndk-clang19-generic-builtin-fallback"


def build_replacement(classic_base: str, value_expr: str, fallback_expr: str) -> str:
    return (
        f"{MARKER}\n"
        f"  if ({value_expr} == 0) return {fallback_expr};\n"
        f"  if (sizeof({value_expr}) <= sizeof(unsigned int))\n"
        f"    return {classic_base}(static_cast<unsigned int>({value_expr}));\n"
        f"  if (sizeof({value_expr}) <= sizeof(unsigned long))\n"
        f"    return {classic_base}l(static_cast<unsigned long>({value_expr}));\n"
        f"  return {classic_base}ll(static_cast<unsigned long long>({value_expr}));"
    )


def patch_file(path: Path, generic_builtin: str, classic_base: str) -> bool:
    if not path.is_file():
        print(f"  SKIP (not found): {path}")
        return False

    text = path.read_text()

    if MARKER in text:
        print(f"  already patched: {path}")
        return True

    if generic_builtin not in text:
        print(f"  {generic_builtin} not present, nothing to do: {path}")
        return True

    match = CALL_RE.search(text)
    if not match:
        print(
            f"  ERROR: found '{generic_builtin}' in {path} but couldn't match the "
            "expected call pattern. Inspect this file manually.",
            file=sys.stderr,
        )
        return False

    value_expr, fallback_expr = match.group(2), match.group(3)
    replacement = build_replacement(classic_base, value_expr, fallback_expr)
    new_text = text[: match.start()] + replacement + text[match.end():]
    path.write_text(new_text)
    print(f"  patched: {path}")
    return True


def main() -> int:
    include_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("module/jni/libcxx/include")
    bit_dir = include_dir / "__bit"

    print(f"Patching libcxx generic bit builtins under: {bit_dir}")

    ok = True
    for filename, generic_builtin, classic_base in TARGETS:
        ok = patch_file(bit_dir / filename, generic_builtin, classic_base) and ok

    if not ok:
        return 1

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
