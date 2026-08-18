#!/usr/bin/env bash
# smoke_guard.sh — run a test suite with the real entrypoints booby-trapped.
#
# WHY THIS EXISTS
# ---------------
# tests/overlay_smoke.sh grew a section whose HEADING contained backticks:
#
#     echo "== 16. `jarvis update` targets the ACTIVE install =="
#
# Inside double quotes that is command substitution, so merely PRINTING the
# section title ran a real `jarvis update` on the host: it reverted branding
# and both feature layers on a live install. The section's own sandbox was
# irrelevant — the substitution fired before the sandbox existed, and the
# shim's fallback then found the machine's real overlay.
#
# Fixing that one quote is not enough. A suite that can mutate the host on a
# quoting slip needs a TRIPWIRE, so the next such mistake fails the build
# instead of the machine.
#
# HOW IT WORKS
# ------------
# Prepends a canary directory to PATH containing fakes for every entrypoint
# that can mutate a real install (jarvis, hermes, and their Windows spellings).
# Each fake records the attempt — argv plus the parent command line — and exits
# non-zero. The suite runs; afterwards ANY recorded hit fails the run and prints
# who tried it.
#
# Legitimate in-suite use of the shim is unaffected: section 16 invokes it by
# ABSOLUTE path ("$OVERLAY_DIR/bin/jarvis"), which never consults PATH. That is
# the distinction being enforced — a bare `jarvis`/`hermes` resolved through
# PATH inside the tests is always a bug, because the tests must only ever touch
# their own sandbox.
#
# Usage:
#   tests/smoke_guard.sh [suite.sh ...]     # default: tests/overlay_smoke.sh
#   tests/smoke_guard.sh --self-test        # prove the tripwire actually trips
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_TMP="$(mktemp -d)"
CANARY_DIR="$GUARD_TMP/canary-bin"
CANARY_LOG="$GUARD_TMP/canary-hits.log"
mkdir -p "$CANARY_DIR"
: > "$CANARY_LOG"
cleanup() { [ -n "${KEEP_GUARD:-}" ] || rm -rf "$GUARD_TMP"; }
trap cleanup EXIT

# One fake per name a test could accidentally resolve through PATH.
for name in jarvis hermes jarvis.cmd hermes.exe jarvis.exe; do
  cat > "$CANARY_DIR/$name" <<CANARY
#!/usr/bin/env bash
# Canary planted by tests/smoke_guard.sh — see that file for why.
{
  echo "HIT: $name \$*"
  echo "     cwd: \$PWD"
  if command -v ps >/dev/null 2>&1; then
    echo "     parent: \$(ps -o args= -p \$PPID 2>/dev/null | head -1)"
  fi
} >> "$CANARY_LOG"
echo "" >&2
echo "  ##################################################################" >&2
echo "  # TEST SUITE TRIPWIRE: '$name' was invoked through PATH." >&2
echo "  #   args: \$*" >&2
echo "  #" >&2
echo "  # The tests must never run the real updater/CLI — that mutates the" >&2
echo "  # host. This is almost always an unquoted backtick or \\$( ) in a" >&2
echo "  # test string, or a sandbox that was not set up before use." >&2
echo "  # Use an ABSOLUTE path to a stub inside the test's own sandbox." >&2
echo "  ##################################################################" >&2
exit 97
CANARY
  chmod +x "$CANARY_DIR/$name"
done

export PATH="$CANARY_DIR:$PATH"
export JARVIS_SMOKE_GUARD=1

# --- self-test: the tripwire must actually trip -----------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "◆ smoke_guard — self-test"
  probe="$GUARD_TMP/probe.sh"
  # Reproduces the exact original defect: backticks inside a double-quoted echo.
  printf '%s\n' '#!/usr/bin/env bash' 'echo "heading with `jarvis update` in it" >/dev/null' > "$probe"
  bash "$probe" >/dev/null 2>&1
  if [ -s "$CANARY_LOG" ]; then
    echo "  ✓ tripwire fired on a backticked \`jarvis update\` (the original bug)"
    echo "    recorded: $(head -1 "$CANARY_LOG")"
    : > "$CANARY_LOG"
  else
    echo "  ✗ tripwire did NOT fire — the guard is broken and would hide a repeat"
    exit 1
  fi
  # And a clean script must leave it silent (no false positives).
  printf '%s\n' '#!/usr/bin/env bash' 'echo "heading with jarvis update in it" >/dev/null' > "$probe"
  bash "$probe" >/dev/null 2>&1
  if [ -s "$CANARY_LOG" ]; then
    echo "  ✗ tripwire fired on a harmless string — too noisy to trust"
    exit 1
  fi
  echo "  ✓ silent on a harmless mention (no false positive)"
  echo "◆ smoke_guard — self-test passed"
  exit 0
fi

SUITES=("$@")
[ ${#SUITES[@]} -eq 0 ] && SUITES=("$HERE/overlay_smoke.sh")

echo "◆ smoke_guard — running $(( ${#SUITES[@]} )) suite(s) with PATH tripwire armed"
echo "  canary bin: $CANARY_DIR"
echo "  shadowing : jarvis hermes jarvis.cmd hermes.exe jarvis.exe"
echo

rc=0
for suite in "${SUITES[@]}"; do
  echo "▶ $suite"
  bash "$suite" || rc=$?
  echo
done

echo "──────────────────────────────────────────────"
if [ -s "$CANARY_LOG" ]; then
  echo "  ✗ TRIPWIRE: the suite invoked a real entrypoint through PATH"
  echo ""
  sed 's/^/    /' "$CANARY_LOG"
  echo ""
  echo "  On a developer machine this would have mutated the live install."
  echo "  Fix the call site; do not weaken the guard."
  echo "──────────────────────────────────────────────"
  exit 1
fi
echo "  ✓ tripwire clean: no real entrypoint was invoked through PATH"
echo "──────────────────────────────────────────────"
exit "$rc"
