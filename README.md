# JARVIS Overlay

A white-label branding overlay for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT).

It brands the **customer-facing surface** of a Hermes install as **JARVIS**
while keeping the underlying Hermes code pristine — so `hermes update` always
pulls clean upstream with **zero merge conflicts**. This is an overlay, *not* a
fork or an in-place edit of upstream.

All three client launch surfaces are branded at full capability parity:
**terminal/PowerShell CLI**, the **desktop app** (Electron), and the **browser
dashboard**.

> Brand: **JARVIS** — deep black `#0A0A0A`, electric blue `#3B82F6`, light blue
> `#60A5FA`. Tagline: *"Your AI Employee. Runs Your Business 24/7."*

## How it works

Branding is applied through **two mechanisms**, chosen so the highest-churn
surface never touches the repo:

1. **CLI via Hermes's native skin engine** — `skins/jarvis.yaml` is copied to
   `~/.hermes/skins/jarvis.yaml` and activated with `display.skin: jarvis`.
   This rebrands the entire interactive CLI (ASCII logo, hero, colors, response
   label, welcome/goodbye/prompt/help) **with no source edits**. Because it
   lives under `~/.hermes` (outside the git checkout), `hermes update` can never
   conflict with it.

2. **Everything else via `apply.sh`** — the dashboard (`web/`), all 32 chat +
   dashboard locale files, server-side theme labels, and the few hardcoded
   brand strings the skin can't reach are rewritten in place from
   `branding.map`. `apply.sh` re-runs after every update.

### Why updates never conflict

`hermes update` is `git pull` with an auto-stash guard: left in place, the
string rewrites would be stashed and replayed onto new upstream — the exact
merge conflict we avoid. So `update-jarvis.sh` does it in the only safe order:

```
revert branded files → hermes update (clean fast-forward) → apply.sh (re-brand)
```

The skin needs none of this — it's outside the repo.

## What is and isn't rebranded

| Rebranded | Left verbatim |
|---|---|
| Brand nouns: `Hermes`, `Hermes Agent` → `JARVIS` | Filesystem paths: `~/.hermes/…` (real dirs the runtime reads) |
| Command invocations: `hermes update` → `jarvis update` (a real `jarvis` shim backs them) | Internal identifiers: `X-Hermes-Session-Token`, `updateHermes`, `HERMES_HOME`, `hermes_cli` |
| Theme labels (client **and** server copies) | The `website/` docs site (ignored entirely) |
| Brand glyph `⚕` → `◆` | Upstream `LICENSE` / `NOTICE` / attribution |
| Desktop wordmark, i18n, macOS `CFBundleDisplayName`/`CFBundleName`, dmg title, permission text, `app.setName` default | Desktop `productName`/`executableName`/`CFBundleExecutable`/`appId`/`hermes://` (the `.app`/`.exe` filename stays "Hermes" so the self-updater, which hardcodes `Hermes.app`/`Hermes.exe`, keeps working) |

A repo-wide audit confirmed no capitalized `"Hermes"` is ever used as a
functional value and no `subprocess("hermes …")` exec strings exist, so the
rewrites can only alter prose, labels, and on-screen instructions — never
behavior. Protected identifiers are masked regardless.

## Layout

```
jarvis-agent/
  apply.sh            # idempotent; installs skin + rewrites visible strings + verify pass
  branding.map        # find→replace rules (protect / literal / regex / command / word / glyph)
  skins/jarvis.yaml   # CLI skin (deep black + electric blue, gradient JARVIS logo)
  persona/JARVIS.md   # agent identity → seeded once as ~/.hermes/SOUL.md
  bin/jarvis          # command shim → exec hermes (UTF-8 console handling)
  bin/jarvis.cmd      # same shim for native Windows shells
  bin/jarvis-banner   # standalone banner renderer (truecolor + ASCII fallbacks)
  assets/banner.png   # placeholder JARVIS banner (swap for final art)
  install-jarvis.sh   # branded installer wrapping setup-hermes.sh
  update-jarvis.sh    # revert → hermes update → apply.sh
  tests/overlay_smoke.sh      # end-to-end validation harness (16 assertions)
  .github/workflows/          # CI (lint + smoke) + scheduled upstream-drift watch
```

## Install

**Easiest — one-command installers** (download from
[xcerebro.ai/jarvis](https://xcerebro.ai/jarvis)):

- **macOS:** `bash jarvis-mac.sh`
- **Windows:** `powershell -ExecutionPolicy Bypass -File jarvis-windows.ps1`

Each installer checks/installs prerequisites (git, Python 3.11+, Node
`^20.19 || >=22.12`), clones Hermes + this overlay, and runs the full install
below. Pass `--dry-run` (mac) / `-DryRun` (Windows) to preview without changing
anything; `--no-desktop` / `-NoDesktop` to skip the desktop build.

**Manual:**

```bash
git clone https://github.com/NousResearch/hermes-agent
git clone https://github.com/xcerebroai/jarvis-agent
cd jarvis-agent
HERMES_SRC=../hermes-agent ./install-jarvis.sh
```

## Getting started

After installing, launch the **JARVIS** desktop app (Start Menu / dock /
shortcut) or run `jarvis` in a terminal. On **first launch** JARVIS will ask you
to:

1. **Connect an AI provider key** — paste an API key (e.g. Anthropic) or sign in
   with a supported provider so the agent can think.
2. **Connect Telegram (optional)** — link a Telegram bot so JARVIS is reachable
   from your phone; WhatsApp and other channels can be added the same way from
   the dashboard.

That's it — no accounts, no billing. Your keys and config live locally in
`~/.hermes`. For provider setup details and channel options, see the
[Hermes Agent docs](https://github.com/NousResearch/hermes-agent#readme).

Then run `jarvis` to start. Update later with `./update-jarvis.sh`.

`apply.sh` and the wrappers auto-detect the Hermes source tree via an installed
`hermes_cli`; pass `HERMES_SRC=/path/to/hermes-agent` to be explicit. Requires
`bash`, `perl` (ships with git), and a Python with `pyyaml` (Hermes provides
one) for the config edit.

## Testing & CI

`tests/overlay_smoke.sh` clones upstream Hermes into a throwaway home, applies
the overlay, and asserts all 30 guarantees (skin loads via Hermes's own engine,
verify pass clean, 0 locale leaks, idempotency, protected identifiers/paths
preserved, commands rebranded, clean-revert, banner fallbacks, desktop Tier-1
rebrand with functional identifiers protected, built-bundle leak detection).
Run it locally:

```bash
python3 -m pip install pyyaml
./tests/overlay_smoke.sh                          # clones upstream
HERMES_SRC=../hermes-agent ./tests/overlay_smoke.sh   # reuse a checkout
```

Two GitHub workflows run it:
- **`ci.yml`** — on push/PR: shellcheck + data validation + the smoke test.
- **`upstream-drift.yml`** — weekly against latest Hermes `main`; if upstream
  introduces a brand surface the overlay doesn't cover, the verify pass fails
  and the workflow opens/updates a tracking issue so `branding.map` can be
  extended before the next customer update.

## Desktop app (Electron)

The desktop app (`apps/desktop`) is **built from source and self-updates via
`git pull` + `hermes desktop --build-only`** — the same source tree and update
model as the CLI (Nous ships no prebuilt desktop binaries). It does **not** use
the CLI skin engine, so its brand lives in source: `apply.sh` rebrands the
wordmark, its own i18n, and the visible `package.json` build fields.

**Tier 1 (display-only):** the app window, dock, menu, About, dmg title, and
macOS permission prompts read **JARVIS**. The bundle/exe filename and `appId`
stay "Hermes" on purpose — Hermes's own updater hardcodes `Hermes.app` /
`Hermes.exe`, so renaming them would break self-update. `install-jarvis.sh`
creates **JARVIS-named launch points** (Windows Start-menu/desktop shortcuts,
a macOS `JARVIS.app` link, a Linux `.desktop` entry) so clients never launch
via a Hermes-named path.

**Update-survival:** `hermes update` rebuilds the desktop from *pristine*
source *before* our re-apply, so `update-jarvis.sh` runs a **trailing branded
rebuild** (`jarvis desktop --build-only`) after re-applying, then verifies the
built renderer bundle. If the desktop was never built on a machine, the rebuild
step is skipped gracefully. Building requires Node `^20.19 || >=22.12`.

## Banner art

`bin/jarvis-banner` and `skins/jarvis.yaml` embed pre-rendered `JARVIS` art
(pyfiglet `ansi_shadow` for UTF-8, `standard` for the ASCII fallback) with a
`#60A5FA → #3B82F6` vertical gradient. No runtime dependency on pyfiglet. To
regenerate after a font/color change, use the tooling in this repo's dev venv.

## Licensing

This overlay wraps MIT-licensed Hermes Agent and retains its license and
attribution in every install (see [`NOTICE`](./NOTICE)). The JARVIS name, art,
persona, and overlay tooling are the property of their owner.
