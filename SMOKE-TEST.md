# JARVIS Overlay — Live Machine Smoke Test

A hands-on runbook for validating the JARVIS overlay on a **real Windows
machine that already has a live, working Hermes install** — existing
`~/.hermes` config, live Telegram + WhatsApp gateways, and local patches to
tracked source files (e.g. `gateway/platforms/qqbot/adapter.py`,
`gateway/run.py`).

Anyone on the team can run this without having built the overlay. Each step has
an **Expected result** and a **PASS/FAIL** box. Do the steps in order; do not
skip the pre-flight.

**Time:** ~30–60 min (the first desktop build is several minutes).
**Shell:** Git Bash (the scripts are bash). Run from the `jarvis-agent` folder.

Conventions:
- `<SRC>` = full path to your Hermes checkout (e.g. `/c/Users/you/hermes-agent`).
- `<HOME>` = your Hermes data dir, normally `~/.hermes`.
- Replace placeholders before running.

---

## Step 1 — Pre-flight: record state, exclude your patches, BACK UP

**Do this before anything else runs.**

**1a. Record the current version and source state.**
```bash
hermes --version                     # or: hermes status | head
git -C <SRC> rev-parse --short HEAD  # record the commit
git -C <SRC> status --porcelain      # record which files you've locally patched
```
Write down the version, the commit, and the list of dirty files.

**1b. Protect your local source patches.** For every tracked file you patched
(from the `git status` above), add its repo-relative path to
`jarvis-agent/branding.exclude` (one per line). This makes the overlay leave
those files **completely alone** — never rebranded, never reverted.
```bash
# example — edit jarvis-agent/branding.exclude and add:
gateway/platforms/qqbot/adapter.py
gateway/run.py
```

**1c. Back up config, secrets, and your patched files.**
```bash
STAMP=$(date +%Y%m%d-%H%M%S)
BK=~/jarvis-preflight-$STAMP
mkdir -p "$BK/home" "$BK/src"
cp -f <HOME>/config.yaml        "$BK/home/" 2>/dev/null
cp -f <HOME>/SOUL.md            "$BK/home/" 2>/dev/null
cp -f <HOME>/.env               "$BK/home/" 2>/dev/null
# your patched source files:
cp -f <SRC>/gateway/platforms/qqbot/adapter.py "$BK/src/" 2>/dev/null
cp -f <SRC>/gateway/run.py                      "$BK/src/" 2>/dev/null
# full config dir snapshot (belt and suspenders):
cp -r <HOME> "$BK/home-full" 2>/dev/null
echo "Backup at: $BK"
```
Also save a copy of your **current `config.yaml`** contents (you'll diff against
it in Step 3):
```bash
cp <HOME>/config.yaml "$BK/config.before.yaml"
```

- **Expected result:** version + commit recorded; your patched files are listed
  in `branding.exclude`; `$BK` contains `config.yaml`, `SOUL.md`, your patched
  files, and a full `~/.hermes` copy.
- **[ ] PASS  [ ] FAIL**

---

## Step 2 — Install

```bash
cd jarvis-agent
HERMES_SRC=<SRC> ./install-jarvis.sh
```
This prints the JARVIS banner, wraps `setup-hermes.sh` (idempotent), installs
the `jarvis` command shim, applies branding, then builds the desktop app
(Step 5) and creates shortcuts.

- **Expected result:** runs to `◆ JARVIS is ready — all three surfaces branded.`
  with no errors. The verify pass prints
  `✓ no visible brand strings survived …`. If you excluded files in Step 1b, you
  see `· excluded N operator-maintained file(s) from branding`.
- **[ ] PASS  [ ] FAIL**

---

## Step 3 — Skin activated by MERGING into existing config

The overlay sets `display.skin: jarvis` by **loading your existing
`config.yaml`, adding the one key, and writing it back** — it does not replace
the file. All your other settings must be intact.

```bash
grep -A1 '^display:' <HOME>/config.yaml          # display.skin: jarvis
ls <HOME>/skins/jarvis.yaml                        # skin installed
# Diff against the pre-flight copy — the ONLY change should be display.skin:
diff "$BK/config.before.yaml" <HOME>/config.yaml
```

- **Expected result:** `display.skin: jarvis` is present; `~/.hermes/skins/jarvis.yaml`
  exists; the `diff` shows **only** the `display.skin` addition (plus possibly
  a re-ordered `display:` block) — every pre-existing key (providers, gateway
  tokens, messaging config, etc.) is unchanged.
- **[ ] PASS  [ ] FAIL**

---

## Step 4 — Your local source patches survived

**How the revert is scoped:** `update-jarvis.sh` reverts **only** the files the
overlay brands (listed in `<HOME>/.jarvis/branded-files.txt`). It is **never** a
blanket `git checkout -- .`. Concretely:

- Files the overlay does **not** brand → **never touched.** Your local
  modifications to them are left exactly as-is (a later `hermes update` stashes
  and restores them as it always has).
- Files that are **both branded and locally patched** → if you added them to
  `branding.exclude` (Step 1b), they are **not** in the branded set, so they are
  never rebranded or reverted — your patch is fully preserved. If you did **not**
  exclude one, the revert step backs it up first (to `<HOME>/.jarvis/backup-*/`)
  and prints `! branded file has a local patch — backed up: <path>`, then
  reverts it — so your change is preserved in the backup, never silently lost.

Verify now:
```bash
git -C <SRC> diff --stat gateway/platforms/qqbot/adapter.py gateway/run.py
```

- **Expected result:** your patched files still show your changes (excluded →
  untouched). If a patched file was **not** excluded, confirm a copy exists
  under `<HOME>/.jarvis/backup-*/` before proceeding, and add it to
  `branding.exclude` now.
- **[ ] PASS  [ ] FAIL**

---

## Step 5 — First real desktop build

The build ran inside Step 2. Confirm the toolchain resolved and record timing.
(If it was skipped for a missing Node, install Node `^20.19 || >=22.12`, then
`jarvis desktop --build-only`.)

```bash
node -v                                            # ^20.19 or >=22.12
ls <SRC>/apps/desktop/dist                          # built renderer bundle
ls <SRC>/apps/desktop/release/*-unpacked/           # packaged app (Hermes.exe)
# time a clean rebuild for the record:
time ( cd <SRC> && jarvis desktop --build-only )
```

- **Expected result:** `dist/` and a `*-unpacked/` app exist; the timed rebuild
  completes without error. Record the build time here: `__________`.
- **[ ] PASS  [ ] FAIL**

---

## Step 6 — Launch the desktop app from the JARVIS shortcut

Open **JARVIS** from the Start Menu (or the Desktop shortcut). Do **not** launch
via any Hermes-named path.

Check each surface:
- **Splash / intro wordmark** reads **JARVIS** (not "HERMES AGENT").
- **Window title** shows JARVIS.
- **Taskbar** hover/label shows JARVIS.
- **About** screen (menu → About JARVIS) shows JARVIS.

- **Expected result:** every visible surface reads JARVIS. (Note: the executable
  file is still `Hermes.exe` by design — that filename is internal and keeps the
  self-updater working; you should never see it in normal use.)
- **[ ] PASS  [ ] FAIL**

---

## Step 7 — Live Telegram + WhatsApp replies show JARVIS

With your gateways running (`jarvis gateway` if not already up), send a real
message from each platform that triggers a branded reply (e.g. `/help`, a status
line, or the WhatsApp reply-prefix header).

- **Expected result:** replies show **JARVIS** branding (e.g. the WhatsApp
  header `◆ *JARVIS*`, help/status text saying JARVIS). No "Hermes Agent" in
  customer-visible message text. (If you excluded `adapter.py`/`run.py`, any
  brand glyph inside those specific files stays as you patched it — that is
  expected and intended.)
- **[ ] PASS  [ ] FAIL**

---

## Step 8 — Full update cycle (timed), patches intact after

```bash
time ./update-jarvis.sh HERMES_SRC=<SRC>    # or: HERMES_SRC=<SRC> ./update-jarvis.sh
```
Watch for, in order: the scoped-revert summary → `hermes update` → re-apply →
the desktop rebuild message **"Rebuilding JARVIS desktop — this takes a few
minutes, don't close."** → `--verify-build`.

Then confirm:
```bash
grep -rl '<<<<<<<' <SRC> | wc -l                    # 0 conflict markers
git -C <SRC> diff --stat gateway/run.py             # your patch still present (if excluded)
grep -A1 '^display:' <HOME>/config.yaml             # skin still jarvis
```

- **Expected result:** the cycle completes; **0** conflict markers; branding
  re-applied (verify prints clean); your excluded local patches are still in
  place; the desktop rebuilt and verified. Record cycle time: `__________`.
- **[ ] PASS  [ ] FAIL**

---

## Step 9 — Browser dashboard, incl. language switch

Start the dashboard (`jarvis gateway` prints the URL, or `jarvis dashboard`) and
open it.

- **Browser tab title** reads **JARVIS - Dashboard**.
- **Sidebar brand label** reads **JARVIS**.
- Switch the dashboard **language to Spanish (Español)** in settings.
- Confirm brand strings still read **JARVIS** in Spanish (proper noun is
  identical across languages).

- **Expected result:** tab title, brand label, and all visible brand strings
  read JARVIS in both English and Spanish.
- **[ ] PASS  [ ] FAIL**

---

## Step 10 — Rollback (if anything above FAILED)

The overlay changes are all reversible. To restore the machine to its
pre-JARVIS state:

**10a. Restore the Hermes source tree to pristine upstream.**
```bash
git -C <SRC> checkout -- .          # discards JARVIS branding from tracked files
git -C <SRC> clean -fd apps/desktop # removes built desktop artifacts (dist/release)
```

**10b. Re-apply your local source patches** from the pre-flight backup:
```bash
cp -f "$BK/src/adapter.py" <SRC>/gateway/platforms/qqbot/adapter.py
cp -f "$BK/src/run.py"     <SRC>/gateway/run.py
```
(Or, if `update-jarvis.sh` backed them up, from `<HOME>/.jarvis/backup-*/`.)

**10c. Restore config / skin.**
```bash
cp -f "$BK/home/config.yaml" <HOME>/config.yaml     # removes display.skin: jarvis
rm -f <HOME>/skins/jarvis.yaml                       # remove the JARVIS skin
# If you want the CLI back to the stock skin immediately:
#   set display.skin back to its old value (or delete the key) in config.yaml
```
If in doubt, restore the entire config dir: `cp -r "$BK/home-full/." <HOME>/`.

**10d. Remove the JARVIS launch points and shim.**
```bash
rm -f ~/.local/bin/jarvis ~/.local/bin/jarvis-banner ~/.local/bin/jarvis.cmd
rm -f "$APPDATA/Microsoft/Windows/Start Menu/Programs/JARVIS.lnk" "$USERPROFILE/Desktop/JARVIS.lnk"
```

**10e. Rebuild the (now un-branded) desktop app** if you had launched it:
```bash
cd <SRC> && hermes desktop --build-only
```

- **Expected result:** `hermes --version` works, config restored (no
  `display.skin: jarvis`), your local patches back in place, no JARVIS
  shortcuts. The machine is back to its pre-test state.
- **[ ] PASS  [ ] FAIL**

---

## What the overlay touches (reference)

| Surface | Rebranded | Left as "Hermes" (functional) |
|---|---|---|
| CLI | banner, colors, labels via `~/.hermes/skins/jarvis.yaml` | `hermes`/`jarvis` are the same runtime |
| Dashboard | title, labels, all 32 locale files, theme labels | — |
| Chat gateways | reply prefixes, message catalogs | `~/.hermes` paths, `X-Hermes-*` headers |
| Desktop app | wordmark, i18n, window/dock/menu/About name, dmg title | `.app`/`.exe` filename, `appId`, `hermes://` (so self-update works) |
| Commands | `hermes <verb>` → `jarvis <verb>` (real shim) | filesystem paths `~/.hermes/…` |

Files you list in `branding.exclude` are never touched.
The branded-file manifest is at `<HOME>/.jarvis/branded-files.txt`;
backups from updates are under `<HOME>/.jarvis/backup-*/`.
