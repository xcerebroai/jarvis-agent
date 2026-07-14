# JARVIS Overlay

A white-label branding overlay for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT).

It brands the **customer-facing surface** of a Hermes install as **JARVIS**
while keeping the underlying Hermes code pristine — so `hermes update` always
pulls clean upstream with **zero merge conflicts**. This is an overlay, *not* a
fork or an in-place edit of upstream.

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

A repo-wide audit confirmed no capitalized `"Hermes"` is ever used as a
functional value and no `subprocess("hermes …")` exec strings exist, so the
rewrites can only alter prose, labels, and on-screen instructions — never
behavior. Protected identifiers are masked regardless.

## Layout

```
jarvis-overlay/
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
```

## Install

```bash
git clone https://github.com/NousResearch/hermes-agent
git clone https://github.com/xcerebroai/jarvis-overlay
cd jarvis-overlay
HERMES_SRC=../hermes-agent ./install-jarvis.sh
```

Then run `jarvis` to start. Update later with `./update-jarvis.sh`.

`apply.sh` and the wrappers auto-detect the Hermes source tree via an installed
`hermes_cli`; pass `HERMES_SRC=/path/to/hermes-agent` to be explicit. Requires
`bash`, `perl` (ships with git), and a Python with `pyyaml` (Hermes provides
one) for the config edit.

## Banner art

`bin/jarvis-banner` and `skins/jarvis.yaml` embed pre-rendered `JARVIS` art
(pyfiglet `ansi_shadow` for UTF-8, `standard` for the ASCII fallback) with a
`#60A5FA → #3B82F6` vertical gradient. No runtime dependency on pyfiglet. To
regenerate after a font/color change, use the tooling in this repo's dev venv.

## Licensing

This overlay wraps MIT-licensed Hermes Agent and retains its license and
attribution in every install (see [`NOTICE`](./NOTICE)). The JARVIS name, art,
persona, and overlay tooling are the property of their owner.
