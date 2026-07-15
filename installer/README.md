# JARVIS double-click installers (`JARVIS-Setup.exe` / `JARVIS-Setup.dmg`)

Branded native installers built from upstream's Tauri bootstrap app
(`hermes-agent/apps/bootstrap-installer`) with the same **overlay discipline**
as the rest of this repo: visible strings + art become JARVIS, functional
identifiers stay untouched, and upstream is **never edited in place** — the
branding is a build-time transform over a throwaway clone.

## How a build works (`.github/workflows/installer-build.yml`)

1. **icons** (ubuntu) — `gen-icons.sh` rasterizes `assets/jarvis-logo.svg` /
   `jarvis-mark.svg` into the `.ico` / `.icns` / PNG set.
2. **build** (windows + macos) — clone upstream Hermes → `brand-installer.sh`
   (rebrand sources + inject the overlay stage) → `cargo check` → `tauri build`:
   - Windows: `tauri build --no-bundle` → `JARVIS-Setup.exe` (the app *is* the
     installer; `Cargo.toml [[bin]]` is renamed).
   - macOS: `tauri build --bundles dmg` → `JARVIS-Setup.dmg`.
   Artifacts upload always; on a published release they attach as assets.

`brand-installer.sh` keeps functional identifiers: the bundle id
`com.nousresearch.hermes.setup`, the Tauri command names, `@nous-research/ui`,
and the pinned `NousResearch/hermes-agent` install-script URL (we *want*
upstream's `scripts/install.ps1` as the base install; JARVIS is layered on top).

## Same end state as the script installers

Upstream `install.ps1`/`install.sh` install **plain Hermes** into the runtime's
home — `%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` elsewhere (via
`hermes_constants.get_hermes_home()`). To reach the JARVIS end state we:

- Set `include_desktop:false` so upstream **skips `Stage-Desktop`** — the only
  place `New-DesktopShortcuts` (a `Hermes.lnk`) is created. Clients therefore
  never get a Hermes shortcut, even transiently.
- Inject a **JARVIS overlay stage** into `bootstrap.rs` that runs after the
  upstream stages (before `Complete`): it clones the overlay and runs
  `install-jarvis.sh` in **overlay-only mode** (`JARVIS_OVERLAY_ONLY=1`) — the
  `jarvis` shim, `apply.sh` branding, the **branded** desktop build, and
  `JARVIS.lnk` shortcuts.

Because the Setup layout uses `%LOCALAPPDATA%\hermes` (not the script
installers' `%USERPROFILE%\jarvis`), `apply.sh` and `update-jarvis.sh` resolve
`HERMES_HOME` via `hermes_constants.get_hermes_home()` (with a bash fallback),
so the skin/SOUL/manifest land in the home the CLI actually reads — on **both**
layouts.

## Update story (explicit)

**The runtime is upstream Hermes; its self-update pulls upstream and would
rebuild unbranded unless we re-apply.** Two update surfaces:

### 1. Desktop "Update" button → `JARVIS-Setup --update` → `update::run_update`
This path is **separate from install** (`run_bootstrap`). It: waits for the old
desktop to exit → `hermes update` (git pull upstream + deps) → `hermes desktop
--build-only` → relaunch. Left alone it would rebuild from freshly-pulled,
**unbranded** source.

**Fix (wired):** `brand-installer.sh` injects a **trailing re-apply** into
`run_update` — a `rebrand` stage that runs `apply.sh` from the persistent
overlay checkout (`<HERMES_HOME>/jarvis-agent`) **before** the rebuild, so the
rebuilt desktop is JARVIS. This is the Setup-path analogue of `update-jarvis.sh`
(revert → pull → **apply**). It is best-effort: a failure is logged and the
rebuild still proceeds (worst case an unbranded rebuild, never a broken update).
It uses the persistent checkout, not a bundled resource, because `--update`
runs the staged bare `hermes-setup.exe`.

### 2. CLI `jarvis update` / `hermes update`
`jarvis` is a shim over `hermes`, so `jarvis update` is a bare upstream pull with
**no re-apply** — branding is lost until `apply.sh` runs again. For the CLI path,
run the overlay updater, which reverts branded files first (clean fast-forward),
pulls, then re-applies:

```
<HERMES_HOME>/jarvis-agent/update-jarvis.sh
```

### Residual edge — the branded working tree
`hermes update --force` auto-stashes local modifications (the branded files) and
replays them; a same-line upstream change could conflict. `update-jarvis.sh`
avoids this entirely by **reverting** branded files before the pull (scoped to
its manifest). The desktop `--update` path relies on upstream's auto-stash plus
the trailing re-apply above; if a conflict ever surfaces it fails loudly with a
logged update error rather than silently shipping a broken tree.

## Signing (hooks present, disabled until credentials)

CI produces working **unsigned** installers today. Signing steps run only when
their secrets exist:

- **Windows — Azure Trusted Signing** (`azure/trusted-signing-action`):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TS_ENDPOINT`, `AZURE_TS_ACCOUNT`, `AZURE_TS_CERT_PROFILE`.
- **macOS — codesign + notarytool** (Tauri-native): `APPLE_SIGNING_IDENTITY`,
  `APPLE_CERTIFICATE` (+ `APPLE_CERTIFICATE_PASSWORD`), and for notarization
  `APPLE_API_ISSUER` + `APPLE_API_KEY` (+ `APPLE_API_KEY_PATH` to the `.p8`) +
  `APPLE_TEAM_ID`.

See the account/secret setup checklist in the PR/commit that introduced this.
