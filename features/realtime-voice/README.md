# Realtime voice feature layer

An **update-safe feature overlay** that adds a configurable OpenAI **Realtime
speech-to-speech** voice assistant to the desktop app — layered onto a *pristine*
Hermes Agent tree the same way the branding overlay is, so `hermes update` still
pulls clean upstream with zero conflicts.

This is the overlay's **second mechanism** alongside branding. Branding rewrites
visible strings; this layer adds *new capability* — new source files plus a
focused patch to a handful of tracked upstream files.

> The public default identity is **JARVIS** (no personal user name, wake phrase
> "hey jarvis", Marin voice, a concise neutral delivery). Everything is
> configurable in `config.yaml` under `voice.realtime.*` — see
> [`config/voice.realtime.defaults.yaml`](./config/voice.realtime.defaults.yaml).
> "Cortana" and any operator-specific identity are a **local config choice
> only** and are never shipped here or implied by this product.

## What it adds

- **OpenAI Realtime WebRTC speech-to-speech** (`gpt-realtime-2.1`) with semantic
  VAD, native barge-in/truncation, minimal voice-layer reasoning, and the Marin
  (configurable) voice. The mic stays live for the whole session.
- **Secure ephemeral-token backend**: `POST /api/audio/realtime/token` mints a
  short-lived Realtime client secret from the customer's standard
  `OPENAI_API_KEY` (or `VOICE_TOOLS_OPENAI_KEY`). The standing key is used only
  as the outbound Bearer and is **never returned or logged**.
- **Configurable identity endpoint**: `POST /api/audio/realtime/config` resolves
  the voice identity from `config.yaml` (no secrets).
- **Rotating greetings** that use the configured user name only in the opening
  greeting; normal replies are concise and do not repeat the name.
- **`use_jarvis` bridge** to the full agent for tools, memory, files, terminal,
  current facts, and execution — with an in-flight tool result pinned to the
  session it started in, surviving route/session/tab switches.
- **Desktop voice supervisor singleton** with global nanostore state that
  survives route/session/tab switches and minimized/backgrounded windows; the
  session ends only on explicit end / app exit; reconnects never replay the
  greeting.
- **Dynamic per-window background throttling** only while voice is active (uses
  the existing stream-throttle authority — no static always-unthrottled windows).
- **Chained STT/TTS fallback** (the existing path) when Realtime is disabled or
  initial setup fails.
- **Optional `review_projects` fast path** — GENERIC and configurable: it reads
  a local JSON index at `voice.realtime.review_projects.index_path`. There is no
  built-in path and no assumption about the index's origin. When it is not
  configured (or the file is absent) the tool is **omitted entirely** and voice
  uses the full agent for project work.

- **P5.1 SIGHT** — `look_at_screen`: on-demand macOS screen capture (Screen
  Recording permission is preflighted; when missing, the grant is requested and
  the Privacy pane opened — the voice explains instead of pretending to see)
  → one downscaled JPEG to an OpenAI vision model (`voice.realtime.sight.model`,
  default `gpt-4.1-mini`) with the same standing key. Every look reports its
  real latency (capture + vision) and a **list-price cost estimate**, spoken
  after the answer, shown on the cockpit plate, and appended to
  `<home>/cache/sight/looks.jsonl`. Delegated *research* is sight-first: the
  agent must `browser_navigate` → `browser_snapshot` → `browser_vision` the key
  pages and name its screenshots (`MEDIA:` lines), which the cockpit shows.
- **P5.1 BUILD SESSIONS** — `start_build(goal)`: a real named agent session
  (`session.create`, title `BUILD · <name>`) plus a durable registry record at
  `<home>/builds/sessions.json` and a linked board entry. The build plans
  first and asks for what it needs (secrets are pasted into the session, never
  spoken); every reply ends with a `STATUS:` line the voice relays. Voice
  routes `build_status` / `build_message` to the right session by name,
  resuming the stored session after an app restart. The cockpit pins one plate
  per build (state, elapsed, live stream, last tool, last status).
- **P5.1 PRIORITY REASONING** — every index row is enriched on read with a
  normalized `priority`, `deadline` (+`days_to_deadline`), `staleness_days`
  (from a content-fingerprint ledger beside the index) and `revenue_relevance`
  (+ outstanding amount, derived from payment data). Voice edits
  (`set_project_field`: "mark X high priority") persist in
  `local-overrides.json` beside the index — sync-proof, merged on every read.
  **Facts** stay on the fast index path; **judgment** ("what should I focus
  on?") goes through `ask_judgment` to the full agent in a dedicated
  `JARVIS · reasoning` session with the whole enriched board + recent activity
  as context (45 s bound; elapsed is reported against the 5–10 s budget).

## Layout

```
features/realtime-voice/
  apply-feature.sh     # idempotent apply | revert | verify; loud on drift
  new-files.manifest   # exact overlay-owned files (drives a scoped revert)
  patches/
    tracked-files.patch  # focused git-apply patch for the tracked upstream files
  files/                 # new source files copied verbatim into the upstream tree
    apps/desktop/src/lib/voice/*          # transport, config, supervisor, delegate (+tests)
    apps/desktop/src/app/chat/composer/hooks/use-voice-session*.ts(x)
    hermes_cli/realtime_voice.py          # config resolution + generic review (pure)
    tests/hermes_cli/test_web_server_realtime_token.py
  config/voice.realtime.defaults.yaml     # documented, non-destructively seeded
```

## Lifecycle (how it stays update-safe)

`apply-feature.sh` is invoked by the overlay's own scripts:

- **`apply.sh`** (section 4c) runs `apply-feature.sh apply` after branding, on
  both the CLI tree and the desktop app's active self-rebuild tree.
- **`update-jarvis.sh`** (step 0b) runs `apply-feature.sh revert` *before* the
  upstream pull, so the pull is a clean fast-forward; `apply.sh` re-applies
  afterwards.
- **In-app updater**: the unwrapped upstream updater discards local tracked
  changes and pulls; the overlay's injected post-update `apply.sh` re-applies
  both branding and this feature.

**Apply** is idempotent and observable, and **fails loudly on upstream drift**
(a moved anchor aborts the patch — it never ships partial voice support).
**Revert** restores an exact clean upstream: a scoped `git checkout` of the
feature's own tracked files plus removal of *only* its declared untracked files.
Config defaults are seeded **non-destructively** (an existing `voice.realtime`
block, voice identity, or key is never overwritten).

```bash
HERMES_SRC=/path/to/hermes-agent ./apply-feature.sh apply    # or revert / verify
```

## Rebuilding the patch after upstream drift

The patch is built against a specific upstream revision. When upstream moves an
anchor, apply aborts with a named drift banner. To rebuild:

1. Check out **current** `NousResearch/hermes-agent` `main` in a scratch worktree.
2. Re-apply the behavior there against the new upstream APIs (port the seams in
   the tracked files; the `files/` payload is mostly self-contained).
3. Regenerate the patch:
   ```bash
   git -C <scratch> diff -- \
     apps/desktop/electron/main.ts apps/desktop/electron/preload.ts \
     apps/desktop/electron/stream-throttle.ts apps/desktop/electron/stream-throttle.test.ts \
     apps/desktop/src/app/chat/composer/hooks/use-composer-voice.ts \
     apps/desktop/src/global.d.ts apps/desktop/src/hermes.ts apps/desktop/src/types/hermes.ts \
     hermes_cli/web_models.py hermes_cli/web_server.py > patches/tracked-files.patch
   ```
4. Refresh `files/` from the scratch tree and re-run the tests below.

## Tests

- `tests/feature_realtime_voice.sh` — apply / verify / idempotency / non-destructive
  seed / exact revert / update re-apply / **drift failure** / static
  personal-and-secret-string scan, against a real upstream checkout.
- `tests/test_realtime_voice_unit.py` — pure-stdlib unit tests of the backend
  config resolution + generic review (no FastAPI needed).
- `files/tests/hermes_cli/test_web_server_realtime_token.py` — the HTTP endpoint
  contract (token minting never leaks the standing key; profile scoping;
  config/review endpoints), run wherever the upstream backend deps are present.
- Desktop `vitest` (`apps/desktop`): `src/lib/voice/*`, the composer voice hooks,
  and `electron/stream-throttle.test.ts`, plus `tsc --noEmit`.

CI runs the shell harness + the pure unit tests on every push, and a dedicated
job clones upstream, applies the feature, and runs the desktop vitest + typecheck.

## Cost & key requirement

Realtime voice calls **OpenAI's Realtime API** and is **billed by OpenAI per
audio minute** (input and output). It needs a standard OpenAI API key in the
customer's environment (`OPENAI_API_KEY`, or `VOICE_TOOLS_OPENAI_KEY`). No key →
no ephemeral secret → the desktop uses the existing chained STT/TTS voice path.

## Wake phrase

The wake phrase is configurable via the existing wake-word providers; the public
default is unchanged upstream behavior. An *arbitrary* custom phrase may require
the optional Sherpa/pypinyin wake-word dependency — install it only if you choose
a phrase the default provider can't match; it is not forced on every customer.
