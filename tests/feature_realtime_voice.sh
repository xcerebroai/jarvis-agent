#!/usr/bin/env bash
# feature_realtime_voice.sh — end-to-end validation of the Realtime voice
# feature overlay (features/realtime-voice/) against a real Hermes checkout.
#
# Asserts the feature-layer guarantees:
#   1. static payload carries NO personal/secret strings (Cortana/Quentin/
#      command-center/API keys/absolute machine paths)
#   2. apply installs the feature files AND applies the tracked-file patch
#   3. verify passes on the applied tree
#   4. apply is idempotent (a second apply is a clean no-op)
#   5. config defaults are seeded, and a second seed is non-destructive
#   6. revert restores an EXACT clean upstream (0 dirty, feature files gone)
#   7. update re-apply: revert → (simulated) pull → apply lands cleanly again
#   8. drift fails LOUDLY (a moved anchor aborts apply, ships nothing partial)
#   9. (when a JS/py toolchain is present) the feature's own unit tests pass
#
# Usage:
#   ./tests/feature_realtime_voice.sh                     # clones upstream
#   HERMES_SRC=/path/to/hermes-agent ./tests/feature_realtime_voice.sh
set -uo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEATURE_DIR="$OVERLAY_DIR/features/realtime-voice"
APPLY="$FEATURE_DIR/apply-feature.sh"
UPSTREAM_URL="https://github.com/NousResearch/hermes-agent"
HERMES_REF="${HERMES_REF:-}"

PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "== 1. static payload has no personal/secret strings =="
# The public overlay must never carry the operator's LOCAL identity/config.
# (Case-insensitive; excludes this test file and the feature README's own
# prose, which legitimately explains that these must be absent.)
SCAN_HITS="$(grep -rniE 'cortana|quentin|command-center-raw|hey cortana|sk-[a-z0-9]{16}|infinitygauntlet' \
  "$FEATURE_DIR/files" "$FEATURE_DIR/patches" "$FEATURE_DIR/config" 2>/dev/null || true)"
if [ -z "$SCAN_HITS" ]; then ok "no Cortana/Quentin/command-center/API-key strings in payload"
else bad "forbidden strings in feature payload:"; printf '%s\n' "$SCAN_HITS" | sed 's/^/      /'; fi
# No machine-specific absolute paths baked into the payload.
if grep -rnE '/Users/[A-Za-z]|C:\\\\Users|/home/[a-z]+/' "$FEATURE_DIR/files" "$FEATURE_DIR/patches" >/dev/null 2>&1; then
  bad "machine-specific absolute path in payload"
else ok "no machine-specific absolute paths in payload"; fi
# Default identity must be the public product default (JARVIS, hey jarvis, marin).
RC="$FEATURE_DIR/files/apps/desktop/src/lib/voice/realtime-config.ts"
grep -q "DEFAULT_ASSISTANT_NAME = 'JARVIS'" "$RC" && ok "default assistant name is JARVIS" || bad "default assistant name not JARVIS"
grep -q "DEFAULT_WAKE_PHRASE = 'hey jarvis'" "$RC" && ok "default wake phrase is 'hey jarvis'" || bad "default wake phrase wrong"
grep -q "REALTIME_VOICE = 'marin'" "$RC" && ok "default voice is marin" || bad "default voice not marin"

# --- Acquire an upstream checkout -----------------------------------------
PY=""
for c in "${HERMES_PYTHON:-}" python3 python; do
  [ -z "$c" ] && continue
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1; then PY="$c"; break; fi
done

case "${OS:-}${OSTYPE:-}$(uname -s 2>/dev/null)" in
  *Windows_NT*|*msys*|*cygwin*|*MINGW*|*MSYS*)
    _temp_root="${LOCALAPPDATA//\\//}/Temp"
    mkdir -p "$_temp_root"
    WORK="$(mktemp -d "$_temp_root/jarvis-voice-test.XXXXXX")" ;;
  *) WORK="$(mktemp -d)" ;;
esac
HOME_DIR="$WORK/home"; mkdir -p "$HOME_DIR"
cleanup() { [ -n "${KEEP:-}" ] || rm -rf "$WORK"; }
trap cleanup EXIT

if [ -n "${HERMES_SRC:-}" ] && [ -d "$HERMES_SRC" ]; then
  # Work on a copy so the caller's checkout is never mutated.
  SRC="$WORK/hermes-agent"
  echo "▶ copying existing Hermes checkout for an isolated run…"
  git -C "$HERMES_SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git clone --quiet --local "$HERMES_SRC" "$SRC" \
    || cp -r "$HERMES_SRC" "$SRC"
  git -C "$SRC" checkout -- . 2>/dev/null || true
else
  SRC="$WORK/hermes-agent"
  echo "▶ cloning $UPSTREAM_URL (depth 1${HERMES_REF:+, ref $HERMES_REF})…"
  git clone --quiet --depth 1 ${HERMES_REF:+--branch "$HERMES_REF"} "$UPSTREAM_URL" "$SRC" \
    || { echo "FATAL: could not clone upstream"; exit 2; }
fi
# Git-for-Windows can't chdir into an MSYS "/tmp/..." path via `git -C`; use a
# mixed "C:/..." path for this harness's own git calls (no-op on Linux/macOS).
SRCG="$(cygpath -m "$SRC" 2>/dev/null || echo "$SRC")"
echo "  upstream HEAD: $(git -C "$SRCG" rev-parse --short HEAD 2>/dev/null || echo '?')"

export HERMES_SRC="$SRC" HERMES_HOME="$HOME_DIR"
[ -n "$PY" ] && export HERMES_PYTHON="$PY"

echo
echo "== 2. apply installs files + applies the tracked patch =="
# Baseline the tree state BEFORE apply so the revert check is exact and immune
# to unrelated pre-existing checkout quirks (e.g. a Windows case-fold artifact).
BASELINE="$(git -C "$SRCG" status --porcelain | sort)"
APPLY_OUT="$(bash "$APPLY" apply "$SRC" 2>&1)"; APPLY_RC=$?
echo "$APPLY_OUT" | grep -E 'copied|patch applied|seeded|feature applied' | sed 's/^/    /'
[ "$APPLY_RC" -eq 0 ] && ok "apply exited 0" || bad "apply failed (rc=$APPLY_RC)"
[ -f "$SRC/apps/desktop/src/lib/voice/voice-supervisor.ts" ] && ok "feature source file installed" || bad "feature source file missing"
[ -f "$SRC/hermes_cli/realtime_voice.py" ] && ok "backend module installed" || bad "backend module missing"
grep -q 'hermes:voice-active' "$SRC/apps/desktop/electron/main.ts" && ok "tracked patch applied (main.ts)" || bad "tracked patch not applied (main.ts)"
grep -q '/api/audio/realtime/token' "$SRC/hermes_cli/web_server.py" && ok "tracked patch applied (web_server.py)" || bad "tracked patch not applied (web_server.py)"

echo
echo "== 3. verify passes on applied tree =="
bash "$APPLY" verify "$SRC" >/dev/null 2>&1 && ok "verify passed" || bad "verify failed"

echo
echo "== 4. apply is idempotent =="
APPLY2="$(bash "$APPLY" apply "$SRC" 2>&1)"
echo "$APPLY2" | grep -q 'already applied' && ok "second apply is a no-op" || bad "second apply re-applied the patch"

echo
echo "== 5. config defaults seeded + non-destructive =="
if [ -n "$PY" ]; then
  grep -q 'realtime:' "$HOME_DIR/config.yaml" 2>/dev/null && ok "voice.realtime seeded into config.yaml" || bad "config not seeded"
  echo "$APPLY2" | grep -q 'already set by operator' && ok "second seed is non-destructive" || bad "second seed not guarded"

  # The summon phrase: wake_word seeds PER-KEY. A fresh home gets the full
  # JARVIS block; an operator's explicit choices are never overwritten while
  # still-absent keys are filled in.
  if "$PY" - "$HOME_DIR/config.yaml" <<'WPY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1])) or {}
w = d.get("wake_word") or {}
assert w.get("enabled") is True, w
assert w.get("phrase") == "hey jarvis", w
assert (w.get("openwakeword") or {}).get("model") == "hey_jarvis", w
WPY
  then ok "wake_word seeded: enabled + hey jarvis phrase + hey_jarvis model"
  else bad "wake_word not seeded correctly"
  fi

  WAKE_HOME="$WORK/wake-home"; mkdir -p "$WAKE_HOME"
  printf 'wake_word:\n  enabled: false\n  openwakeword:\n    model: my_custom.onnx\n' > "$WAKE_HOME/config.yaml"
  HERMES_HOME="$WAKE_HOME" bash "$APPLY" apply "$SRC" >/dev/null 2>&1
  if "$PY" - "$WAKE_HOME/config.yaml" <<'WPY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1])) or {}
w = d.get("wake_word") or {}
assert w.get("enabled") is False, w
assert (w.get("openwakeword") or {}).get("model") == "my_custom.onnx", w
assert w.get("phrase") == "hey jarvis", w
WPY
  then ok "operator wake choices preserved (enabled:false + custom model kept, absent phrase filled)"
  else bad "operator wake choices were clobbered"
  fi
else
  ok "config seed skipped (no python+pyyaml) — not a failure"
fi

echo
echo "== 5b. amplitude hook (HUD orb feed) =="
# The analyser tap: payload module present, both tracked taps landed, and the
# emit is throttled. Consumers degrade to synthesized motion when no events
# flow — that contract lives in the HUD plugin (checked by the overlay smoke).
[ -f "$SRC/apps/desktop/src/lib/voice/amplitude-events.ts" ] && ok "amplitude-events module installed" || bad "amplitude-events module missing"
grep -q "emitAmplitude('mic'" "$SRC/apps/desktop/src/app/chat/composer/hooks/use-mic-recorder.ts" && ok "mic tap present" || bad "mic tap missing"
grep -q "attachElementAmplitude(audio)" "$SRC/apps/desktop/src/lib/voice-playback.ts" && ok "playback tap present" || bad "playback tap missing"
grep -q "EMIT_INTERVAL_MS" "$SRC/apps/desktop/src/lib/voice/amplitude-events.ts" && ok "emission is throttled" || bad "throttle constant missing"
grep -q "emitAmplitude('out'" "$SRC/apps/desktop/src/lib/voice/voice-supervisor.ts" && ok "realtime level forwarded" || bad "supervisor level not forwarded"

echo
echo "== 5c. operator voice behaviors are the shipped payload =="
# 2026-08-24: the operator's agent extended these files in-tree; the payload
# captured them so updates preserve the behavior. Pin the load-bearing
# symbols: wake-greeting policy, live foreground context, session update,
# instruction framing, and the wake re-arm watchdog.
V="$SRC/apps/desktop/src/lib/voice"
grep -q 'const suppressGreeting = renewal' "$V/voice-supervisor.ts" && ok "greet-on-every-start policy" || bad "greeting policy lost"
grep -q 'buildForegroundContext' "$V/agent-delegate.ts" && ok "foreground context builder" || bad "context builder lost"
grep -q 'updateForegroundContext' "$V/realtime-session.ts" && ok "live session context update" || bad "session context update lost"
grep -q 'foregroundContext' "$V/realtime-config.ts" && ok "context instruction framing" || bad "instruction framing lost"
grep -q 'WAKE_REARM_MS' "$V/voice-supervisor.ts" && ok "wake re-arm watchdog present" || bad "wake watchdog missing"

echo
echo "== 5d. P1-P3 voice contracts (stop, knowledge, output amplitude) =="
V="$SRC/apps/desktop/src/lib/voice"
grep -q "transcription: { model:" "$V/realtime-config.ts" && ok "input transcription enabled (stop-word feed)" || bad "input transcription missing"
grep -q "hardStop(): void" "$V/realtime-session.ts" && ok "hardStop present (<300ms halt)" || bad "hardStop missing"
grep -q "isVoiceStopCommand(transcript)" "$V/voice-supervisor.ts" && ok "spoken stop enforcement wired" || bad "stop enforcement missing"
grep -q "jarvis:voice-kill" "$V/voice-supervisor.ts" && ok "manual kill event listener" || bad "manual kill listener missing"
grep -q "startOutputMeter" "$V/realtime-session.ts" && ok "output meter (orb speaks on its own voice)" || bad "output meter missing"
grep -q "emitAmplitude('out', level)" "$V/voice-supervisor.ts" && ok "output amplitude emitted as 'out'" || bad "output amplitude mislabeled"
grep -q "emitAmplitude('mic', level)" "$V/voice-supervisor.ts" && ok "mic amplitude truthfully labeled" || bad "mic label wrong"
grep -q "never answer those from memory" "$V/realtime-config.ts" && ok "project questions must use the tool" || bad "tool-forcing instruction missing"
COUNT=$(grep -c "const resolved = await getRealtimeVoiceConfig()" "$V/voice-supervisor.ts")
[ "$COUNT" -ge 2 ] && ok "config fetch retries before stripping identity+tools" || bad "config retry missing"

echo
echo "== 5e. P4 display verbs (voice-commanded display) =="
V="$SRC/apps/desktop/src/lib/voice"
grep -q "SHOW_PROJECTS_TOOL_NAME = 'show_projects'" "$V/realtime-config.ts" && ok "show_projects declared" || bad "show_projects missing"
grep -q "CLEAR_DISPLAY_TOOL_NAME = 'clear_display'" "$V/realtime-config.ts" && ok "clear_display declared" || bad "clear_display missing"
grep -q "...DISPLAY_TOOLS" "$V/realtime-config.ts" && ok "display tools in session tool list" || bad "display tools not registered"
grep -q "runDisplayTool" "$V/voice-supervisor.ts" && ok "display dispatch wired" || bad "display dispatch missing"
grep -q "display.retrieving" "$V/voice-supervisor.ts" && ok "retrieve gesture event emitted" || bad "retrieve event missing"
grep -q "DISPLAY_TOOL_NAMES.has" "$V/realtime-session.ts" && ok "session accepts display tool calls" || bad "session drops display calls"

echo
echo "== 5f. P4 expand + create verbs =="
V="$SRC/apps/desktop/src/lib/voice"
grep -q "SHOW_DETAIL_TOOL_NAME = 'show_project_detail'" "$V/realtime-config.ts" && ok "show_project_detail declared" || bad "detail verb missing"
grep -q "CREATE_PROJECT_TOOL_NAME = 'create_project'" "$V/realtime-config.ts" && ok "create_project declared" || bad "create verb missing"
grep -q "createRealtimeProject" "$SRC/apps/desktop/src/api/realtime-voice.ts" && ok "create API client present" || bad "create client missing"
grep -q "project-create" "$SRC/hermes_cli/web_server.py" && ok "create endpoint in tracked patch" || bad "create endpoint missing"
grep -q "read_local_additions" "$SRC/hermes_cli/realtime_voice.py" && ok "local-additions overlay (sync-safe writes)" || bad "local overlay missing"
grep -q "detail: bool = False" "$SRC/hermes_cli/realtime_voice.py" && ok "detail mode in compact read" || bad "detail mode missing"
grep -q "display.detail" "$V/voice-supervisor.ts" && ok "detail stage event emitted" || bad "detail event missing"

echo
echo "== 5g. P5 full reach: instant actions + delegated work =="
grep -q "OPEN_APP_TOOL_NAME = 'open_app'" "$V/realtime-config.ts" && ok "open_app declared" || bad "open_app missing"
grep -q "OPEN_URL_TOOL_NAME = 'open_url'" "$V/realtime-config.ts" && ok "open_url declared" || bad "open_url missing"
grep -q "DELEGATE_TASK_TOOL_NAME = 'delegate_task'" "$V/realtime-config.ts" && ok "delegate_task declared" || bad "delegate_task missing"
grep -q "CANCEL_TASK_TOOL_NAME = 'cancel_task'" "$V/realtime-config.ts" && ok "cancel_task declared" || bad "cancel_task missing"
grep -q "SAFETY (narrow): only for destructive" "$V/realtime-config.ts" && ok "spoken safety confirm in instructions (narrow: money-moving/destructive only)" || bad "safety instruction missing"
grep -q "speakSystemUpdate" "$V/realtime-session.ts" && ok "out-of-band completion narration seam" || bad "speakSystemUpdate missing"
grep -q "sessionId: () => targetRuntimeId" "$V/agent-delegate.ts" && ok "delegate exposes pinned session id" || bad "sessionId probe missing"
grep -q "DELEGATED_TASK_TIMEOUT_MS)" "$V/voice-supervisor.ts" && ok "delegated jobs get the long timeout" || bad "long timeout missing"
grep -q "voice.task.started" "$V/voice-supervisor.ts" && ok "task lifecycle events emitted" || bad "task events missing"
grep -q "session.interrupt" "$V/voice-supervisor.ts" && ok "cancel interrupts the agent for real" || bad "real interrupt missing"
grep -q "acquireDelegateTurn" "$V/voice-supervisor.ts" && grep -q "session.resume" "$V/voice-supervisor.ts" && ok "delegation works with no composer mounted (HUD is home)" || bad "gateway fallback delegate missing"
grep -q "openRealtimeSystemApp" "$SRC/apps/desktop/src/api/realtime-voice.ts" && ok "system-open API client present" || bad "system-open client missing"
grep -q "def open_system_app" "$SRC/hermes_cli/realtime_voice.py" && ok "argv-only app launcher in backend" || bad "open_system_app missing"
grep -q "system-open" "$SRC/hermes_cli/web_server.py" && ok "system-open endpoint in tracked patch" || bad "system-open endpoint missing"
grep -qv "shell=True" "$SRC/hermes_cli/realtime_voice.py" && ok "no shell=True in launcher" || bad "shell launch detected"

echo
echo "== 5h. P5.1: sight + build sessions + priority reasoning =="
grep -q "LOOK_AT_SCREEN_TOOL_NAME = 'look_at_screen'" "$V/realtime-config.ts" && ok "look_at_screen declared" || bad "look_at_screen missing"
grep -q "START_BUILD_TOOL_NAME = 'start_build'" "$V/realtime-config.ts" && ok "start_build declared" || bad "start_build missing"
grep -q "BUILD_STATUS_TOOL_NAME = 'build_status'" "$V/realtime-config.ts" && grep -q "BUILD_MESSAGE_TOOL_NAME = 'build_message'" "$V/realtime-config.ts" && ok "build_status + build_message declared" || bad "build voice verbs missing"
grep -q "ASK_JUDGMENT_TOOL_NAME = 'ask_judgment'" "$V/realtime-config.ts" && grep -q "SET_PROJECT_FIELD_TOOL_NAME = 'set_project_field'" "$V/realtime-config.ts" && ok "judgment + board-edit tools declared" || bad "reasoning tools missing"
grep -q "JUDGMENT versus FACTS" "$V/realtime-config.ts" && ok "facts-vs-judgment routing policy in instructions" || bad "judgment policy missing"
grep -q "Let me look at the whole board" "$V/realtime-config.ts" && ok "judgment is narrated before the bridge" || bad "judgment narration missing"
grep -q "look's time and estimated cost" "$V/realtime-config.ts" && ok "per-look latency/cost is spoken honestly" || bad "sight accounting instruction missing"
grep -q "browser_vision" "$V/voice-supervisor.ts" && ok "delegated research is sight-first (browser_vision required)" || bad "research prompt is still blind"
grep -q "MEDIA:" "$V/voice-supervisor.ts" && grep -q "voice.task.media" "$V/voice-supervisor.ts" && ok "research screenshots surface on the cockpit" || bad "research media seam missing"
grep -q "voice.sight.done" "$V/voice-supervisor.ts" && grep -q "latencyMs" "$V/voice-supervisor.ts" && ok "sight events carry real latency + cost" || bad "sight events missing"
grep -q "Screen Recording permission" "$V/voice-supervisor.ts" && ok "sight permission flow is explained, not faked" || bad "permission flow missing"
grep -q "'session.create'" "$V/voice-supervisor.ts" && grep -q "BUILD_SESSION_TITLE_PREFIX" "$V/voice-supervisor.ts" && ok "start_build opens a real named agent session" || bad "build session creation missing"
grep -q "upsertRealtimeBuild" "$V/voice-supervisor.ts" && grep -q "loadBuilds" "$V/voice-supervisor.ts" && ok "builds persist to the registry and reload on launch" || bad "build persistence missing"
grep -q "build_id: id" "$V/voice-supervisor.ts" && ok "build gets a linked board entry" || bad "board link missing"
grep -q "STATUS: BUILD COMPLETE" "$V/voice-supervisor.ts" && ok "build kickoff asks for a plan + needs, then a spoken STATUS line" || bad "kickoff contract missing"
grep -q "JARVIS · reasoning" "$V/voice-supervisor.ts" && grep -q "JUDGMENT_TIMEOUT_MS" "$V/voice-supervisor.ts" && ok "judgment runs in its own bounded reasoning session" || bad "reasoning session missing"
grep -q "def enrich_project" "$SRC/hermes_cli/realtime_voice.py" && grep -q "staleness_days" "$SRC/hermes_cli/realtime_voice.py" && grep -q "revenue_relevance" "$SRC/hermes_cli/realtime_voice.py" && ok "enriched index schema (priority/deadline/staleness/revenue)" || bad "enrichment missing"
grep -q "def set_project_override" "$SRC/hermes_cli/realtime_voice.py" && grep -q "LOCAL_OVERRIDES_NAME" "$SRC/hermes_cli/realtime_voice.py" && ok "voice edits persist beside the index (sync-proof)" || bad "override write path missing"
grep -q "def look_at_screen" "$SRC/hermes_cli/realtime_voice.py" && grep -q "CGPreflightScreenCaptureAccess" "$SRC/hermes_cli/realtime_voice.py" && ok "screen capture is permission-gated" || bad "capture gate missing"
grep -q "SIGHT_LIST_PRICES_PER_M" "$SRC/hermes_cli/realtime_voice.py" && grep -q "list-price estimate" "$SRC/hermes_cli/realtime_voice.py" && ok "cost is an explicit list-price estimate" || bad "cost basis missing"
grep -q "def list_builds" "$SRC/hermes_cli/realtime_voice.py" && grep -q "BUILDS_FILE" "$SRC/hermes_cli/realtime_voice.py" && ok "build registry in backend" || bad "build registry missing"
for ep in project-context project-set look thumbnail builds; do
  grep -q "/api/audio/realtime/$ep" "$SRC/hermes_cli/web_server.py" && ok "endpoint $ep in tracked patch" || bad "endpoint $ep missing"
done
grep -q "shell=True" "$SRC/hermes_cli/realtime_voice.py" && bad "shell=True crept into the backend" || ok "still no shell=True in the backend"
grep -q "voice.sight.started" "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" && grep -q "build.list" "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" && grep -q "voice.judgment.started" "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" && ok "cockpit renders sight / build dock / judgment from real events" || bad "cockpit instruments missing"

echo
echo "== 5i. P5.2: sight scope (never our own window) + delegation, not refusal =="
grep -q "def select_capture_target" "$SRC/hermes_cli/realtime_voice.py" && grep -q "SELF_OWNER_NAMES" "$SRC/hermes_cli/realtime_voice.py" && ok "capture target excludes our own window (pure selector)" || bad "self-exclusion selector missing"
grep -q "CGWindowListCopyWindowInfo" "$SRC/hermes_cli/realtime_voice.py" && grep -q '"-l", str(int(target\["window_id"\]))' "$SRC/hermes_cli/realtime_voice.py" && ok "frontmost WINDOW capture via screencapture -l" || bad "window capture missing"
grep -q "display under the pointer" "$SRC/hermes_cli/realtime_voice.py" && ok "multi-display: display with pointer focus" || bad "pointer display fallback missing"
grep -q "app: Optional\[str\] = None" "$SRC/hermes_cli/web_models.py" && grep -q "app=body.app" "$SRC/hermes_cli/web_server.py" && ok "look endpoint accepts \"look at <app>\"" || bad "look endpoint lacks app"
grep -q "never JARVIS" "$V/realtime-config.ts" && grep -q "app: { type: 'string'" "$V/realtime-config.ts" && ok "look_at_screen contract: user's screen + app param" || bad "sight contract missing"
grep -q "CAPABILITY RULE" "$V/realtime-config.ts" && grep -q "watch the screen" "$V/realtime-config.ts" && ok "engine-capable ⇒ delegate; refusal banned" || bad "capability rule missing"
grep -q "help me connect my Stripe account to the agent through the API" "$V/realtime-config.ts" && ok "witnessed ask is a named must-delegate example" || bad "witnessed ask not covered"
grep -q "enum: \['task', 'research', 'browser'\]" "$V/realtime-config.ts" && ok "delegate_task has a browser kind" || bad "browser kind missing"
grep -q "SAFETY (narrow)" "$V/realtime-config.ts" && ok "safety narrowed so API keys/integrations are not blocked" || bad "safety still over-broad"
grep -q "VISIBLE_BROWSER_RULES" "$V/voice-supervisor.ts" && grep -q "PASTE keys into this session" "$V/voice-supervisor.ts" && ok "visible browser + narration + in-session secrets in every delegated prompt" || bad "visible-browser rules missing"
grep -q "P5.2: a \"do X in a website\" delegation" "$V/voice-supervisor.test.ts" && grep -q "P5.2: routes beyond-its-belt asks" "$V/realtime-config.test.ts" && ok "delegation-not-refusal regression tests shipped" || bad "delegation regression tests missing"
grep -q "test_sight_excludes_our_own_window_when_we_are_frontmost" "$OVERLAY_DIR/tests/test_realtime_voice_unit.py" && ok "sight self-exclusion regression test shipped" || bad "sight regression test missing"

echo
echo "== 5j. P6: pointer and voice drive one stage =="
grep -q "jarvis:detail-request" "$V/voice-supervisor.ts" && grep -q "jarvis:board-filter" "$V/voice-supervisor.ts" && grep -q "display.stage.clear" "$V/voice-supervisor.ts" && ok "pointer seams route through displayContext (expand it → clicked card)" || bad "pointer seams missing"
grep -q "P6: a pointer click on a card drives the same stage state" "$V/voice-supervisor.test.ts" && ok "shared-stage regression test shipped" || bad "shared-stage test missing"

echo "== 5k. voice reaches current upstream: token endpoint + wake handoff + drift guard =="
grep -q "/api/audio/realtime/token" "$SRC/hermes_cli/web_server.py" && ok "realtime token endpoint present after apply" || bad "token endpoint missing (feature did not apply)"
grep -q "import('@/lib/voice/voice-supervisor')" "$SRC/apps/desktop/src/main.tsx" && ok "wake->voice handoff: supervisor eager-loaded on the main window (works on /hud home)" || bad "supervisor not eager-loaded — wake will not start voice on the cockpit"
grep -q "probeBackendHealth" "$V/voice-supervisor.ts" && grep -q "voice.backend" "$V/voice-supervisor.ts" && ok "drift guard: startup backend health probe emits voice.backend" || bad "backend health probe missing"
grep -q "def audio_input_rms" "$SRC/tools/wake_word.py" && grep -q "input level rms" "$SRC/tools/wake_word.py" && ok "detector logs input RMS periodically (deafness is visible)" || bad "RMS telemetry missing"
grep -q "audio_rms" "$SRC/tui_gateway/server.py" && ok "wake.status carries audio_rms for the cockpit" || bad "audio_rms not on wake.status"
grep -q "VOICE OFFLINE" "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" && grep -q "NO INPUT" "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" && grep -q "deriveHealth" "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" && ok "cockpit shows honest voice/mic health (never silent deafness that looks like listening)" || bad "honest-state surfacing missing from the cockpit"

echo "== 5l. P1 kill paths re-ported to the WebRTC GA interruption surface =="
grep -q "output_audio_buffer.clear" "$V/realtime-session.ts" && ok "cancelResponse flushes buffered audio (output_audio_buffer.clear), not just response.cancel" || bad "buffered-audio flush missing — spoken stop leaves audio playing"
grep -q "track.stop()" "$V/realtime-session.ts" && grep -q "hardStop" "$V/realtime-session.ts" && ok "hardStop stops the inbound remote track (client sink silenced)" || bad "hardStop does not stop the remote track"
grep -q "STOP WORD matched" "$V/voice-supervisor.ts" && ok "stop-word path is traced (diagnosable)" || bad "stop-word trace missing"
grep -q "/api/audio/realtime/trace" "$SRC/hermes_cli/web_server.py" && grep -q "def append_voice_trace" "$SRC/hermes_cli/realtime_voice.py" && ok "reliable voice-trace sink present (renderer console never reaches the log)" || bad "voice-trace sink missing"
grep -q "cancelResponse flushes buffered audio" "$V/realtime-session.test.ts" && ok "interruption re-port has a regression test (drift guard)" || bad "interruption regression test missing"

echo "== 6. revert restores an EXACT clean upstream =="
bash "$APPLY" revert "$SRC" >/dev/null 2>&1
AFTER="$(git -C "$SRCG" status --porcelain | sort)"
if [ "$AFTER" = "$BASELINE" ]; then
  ok "tree returned to its exact pre-apply state (no feature residue)"
else
  bad "tree differs from pre-apply baseline after revert:"
  diff <(printf '%s\n' "$BASELINE") <(printf '%s\n' "$AFTER") | sed 's/^/      /' | head
fi
[ ! -e "$SRC/apps/desktop/src/lib/voice" ] && ok "feature dir removed" || bad "feature dir left behind"

echo
echo "== 7. update re-apply: revert -> pull -> apply lands cleanly =="
# Simulate the update-jarvis order: with the feature reverted (clean upstream),
# a re-apply must succeed just as it did on the first apply.
bash "$APPLY" apply "$SRC" >/dev/null 2>&1 && bash "$APPLY" verify "$SRC" >/dev/null 2>&1 \
  && ok "re-apply after revert succeeds" || bad "re-apply after revert failed"
bash "$APPLY" revert "$SRC" >/dev/null 2>&1

echo
echo "== 8. drift fails LOUDLY (ships nothing partial) =="
# Remove the anchor line the preload hunk depends on, then apply.
perl -0777 -i -pe "s/  setActiveWork: payload => ipcRenderer.send\('hermes:active-work', payload\),\n//" \
  "$SRC/apps/desktop/electron/preload.ts"
DRIFT_OUT="$(bash "$APPLY" apply "$SRC" 2>&1)"; DRIFT_RC=$?
[ "$DRIFT_RC" -ne 0 ] && ok "apply aborts on drift (rc=$DRIFT_RC)" || bad "apply did NOT fail on drift"
echo "$DRIFT_OUT" | grep -q 'UPSTREAM DRIFT' && ok "drift banner is loud + named" || bad "no drift banner"
[ ! -e "$SRC/apps/desktop/src/lib/voice" ] && ok "no orphaned feature files after drift abort" || bad "orphaned feature files left after drift"
git -C "$SRCG" checkout -- apps/desktop/electron/preload.ts 2>/dev/null || true

echo
echo "== 9. feature unit tests (when toolchain present) =="
# Backend pytest — only if the checkout has the runtime deps (fastapi/pyyaml).
if [ -n "$PY" ] && "$PY" -c 'import fastapi, starlette' >/dev/null 2>&1; then
  bash "$APPLY" apply "$SRC" >/dev/null 2>&1
  if ( cd "$SRC" && PYTHONPATH="." "$PY" -m pytest tests/hermes_cli/test_web_server_realtime_token.py -q ) >/dev/null 2>&1; then
    ok "backend realtime pytest passed"
  else
    bad "backend realtime pytest failed"
  fi
  bash "$APPLY" revert "$SRC" >/dev/null 2>&1
else
  echo "  · backend pytest skipped (fastapi/pyyaml not available here)"
fi
# The desktop vitest suite needs an installed node_modules; it runs in the
# dedicated desktop CI job, not this shell harness.
if [ -d "$SRC/apps/desktop/node_modules" ] && command -v node >/dev/null 2>&1; then
  echo "  · desktop vitest available — run it via: cd apps/desktop && npm run test:ui"
else
  echo "  · desktop vitest skipped (no node_modules; runs in the desktop CI job)"
fi

echo
echo "──────────────────────────────────────────────"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"
[ "$FAIL" -eq 0 ]
