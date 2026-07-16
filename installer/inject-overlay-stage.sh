#!/usr/bin/env bash
# inject-overlay-stage.sh — wire the JARVIS overlay stage into the Tauri app.
#
# Called by brand-installer.sh. Idempotent injections (each independently
# guarded so a partial run repairs):
#
#   1. Copy the overlay scripts into src-tauri/resources/ — the COMPILE-TIME
#      source for include_str!. They are EMBEDDED in the binary, not bundled
#      as loose Tauri resources: the shipped Windows artifact is a bare
#      JARVIS-Setup.exe with no files next to it, so resource-dir loading can
#      never work there (finding #1). At run time the embedded script is
#      written to the bootstrap cache dir and executed from that stable path.
#   1b. jarvis_dmg.rs copied into src-tauri/src/ + lib.rs wired (mod decl +
#      a hop_or_eject() call at the top of run(), ahead of the launcher fast
#      path): launching Setup from inside the mounted .dmg stages the bundle
#      into the bootstrap cache, relaunches from the copy, and ejects the
#      image — fixes the "can't eject / Resource busy" DMG UX bug.
#   2. bootstrap.rs: an overlay-stage call after the upstream stage loop,
#      before Complete; a synthetic StageInfo pushed into the Manifest EVENT
#      so the stage is visible in the UI (the frontend drops Stage events for
#      names it never saw in a manifest — finding #3); the embedded-script
#      helper with the overlay ref BAKED at build time (finding #5).
#   3. update.rs: a `rebrand` StageInfo in the synthetic update manifest
#      (same visibility rule, finding #3); a manifest-scoped revert of the
#      branded files BEFORE `hermes update` so the pull fast-forwards with
#      nothing to autostash (finding #19); the re-apply + helper that rebrands
#      before the desktop rebuild (finding from the original update-story).
#
# Upstream install.ps1 / install.sh are NEVER modified — only the Tauri app
# (whose branded build we own) gets the injected code.
#
# Env: JARVIS_OVERLAY_REF — ref baked into the binary (default main). CI passes
# the exact overlay commit SHA so shipped installers apply the tested overlay.
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:?usage: inject-overlay-stage.sh /path/to/hermes-agent}"
APP="$SRC/apps/bootstrap-installer"
TAURI="$APP/src-tauri"
[ -d "$TAURI" ] || { echo "ERROR: $TAURI not found." >&2; exit 1; }

# Sanitize the ref (goes into a Rust string literal + git fetch argv).
REF="${JARVIS_OVERLAY_REF:-main}"
case "$REF" in
  *[!A-Za-z0-9._/-]*) echo "ERROR: JARVIS_OVERLAY_REF '$REF' contains unsafe characters." >&2; exit 1 ;;
esac

# --- 1. Stage the overlay scripts as compile-time include_str! sources ------
mkdir -p "$TAURI/resources"
cp -f "$OVERLAY_DIR/installer/overlay-stage/jarvis-overlay.sh"  "$TAURI/resources/jarvis-overlay.sh"
cp -f "$OVERLAY_DIR/installer/overlay-stage/jarvis-overlay.ps1" "$TAURI/resources/jarvis-overlay.ps1"
echo "  overlay scripts -> src-tauri/resources/ (embedded via include_str!)"

BR="$TAURI/src/bootstrap.rs"
UR="$TAURI/src/update.rs"
LR="$TAURI/src/lib.rs"

# --- 1b. DMG hop module (macOS eject fix) ------------------------------------
# Launching Setup from inside the mounted .dmg pins the volume (hdiutil
# detach -> "Resource busy"). jarvis_dmg.rs stages the bundle into the
# bootstrap cache, relaunches from the copy, and ejects the image before the
# UI starts. Module file is copied verbatim; lib.rs gets a mod declaration and
# one call at the top of run(), ahead of the launcher fast path.
cp -f "$OVERLAY_DIR/installer/overlay-stage/jarvis_dmg.rs" "$TAURI/src/jarvis_dmg.rs"
echo "  jarvis_dmg.rs -> src-tauri/src/ (DMG hop module)"

if grep -q 'mod jarvis_dmg;' "$LR"; then
  echo "  lib.rs: jarvis_dmg mod already declared (idempotent)"
else
  perl -0777 -pi -e 's{^mod update;$}{mod update;\n// JARVIS overlay: DMG hop (macOS eject fix) — see src/jarvis_dmg.rs.\nmod jarvis_dmg;}m' "$LR"
  grep -q 'mod jarvis_dmg;' "$LR" || { echo "ERROR: jarvis_dmg mod not declared — anchor changed upstream?" >&2; exit 1; }
  echo "  lib.rs: mod jarvis_dmg declared"
fi

if grep -q 'jarvis_dmg::hop_or_eject' "$LR"; then
  echo "  lib.rs: DMG hop call already present (idempotent)"
else
  perl -0777 -pi -e 's{(    tracing::info!\(\?mode, force_setup, "Hermes installer starting"\);)}{$1\n    // JARVIS overlay: hop out of a mounted DMG (and eject it) BEFORE the\n    // launcher fast path or any UI — see src/jarvis_dmg.rs.\n    jarvis_dmg::hop_or_eject();}g' "$LR"
  grep -q 'jarvis_dmg::hop_or_eject' "$LR" || { echo "ERROR: DMG hop call not injected — anchor changed upstream?" >&2; exit 1; }
  echo "  lib.rs: DMG hop call injected at top of run()"
fi

# --- 2a. bootstrap.rs: overlay-stage call after the upstream stage loop -----
if grep -q 'JARVIS overlay stage (injected' "$BR"; then
  echo "  bootstrap.rs: overlay call already present (idempotent)"
else
  perl -0777 -pi -e 's{(    let install_root = PathBuf::from\(&hermes_home\)\.join\("hermes-agent"\);)}{$1\n    // --- JARVIS overlay stage (injected by the JARVIS overlay; upstream untouched) ---\n    // Layer branding + branded desktop + JARVIS shortcuts on top of the pristine\n    // install install.ps1 produced. Runs before Complete so a failure here surfaces\n    // as a failed install, never a half-branded one.\n    \{\n        let started = Instant::now();\n        emit_event(&app, BootstrapEvent::Stage \{ name: "jarvis-overlay".into(), state: StageState::Running, duration_ms: None, result: None, error: None \});\n        match jarvis_overlay_run(&app, &install_root, args.hermes_home.as_deref(), &emit_log).await \{\n            Ok(()) => emit_event(&app, BootstrapEvent::Stage \{ name: "jarvis-overlay".into(), state: StageState::Succeeded, duration_ms: Some(started.elapsed().as_millis() as u64), result: None, error: None \}),\n            Err(e) => \{\n                let msg = format!("JARVIS overlay stage failed: \{e:#\}");\n                emit_event(&app, BootstrapEvent::Stage \{ name: "jarvis-overlay".into(), state: StageState::Failed, duration_ms: Some(started.elapsed().as_millis() as u64), result: None, error: Some(msg.clone()) \});\n                emit_event(&app, BootstrapEvent::Failed \{ stage: Some("jarvis-overlay".into()), error: msg.clone() \});\n                return Err(anyhow!(msg));\n            \}\n        \}\n    \}\n}g' "$BR"
  grep -q 'JARVIS overlay stage (injected' "$BR" || { echo "ERROR: overlay call block not injected — anchor changed upstream?" >&2; exit 1; }
  echo "  bootstrap.rs: overlay call injected"
fi

# --- 2b. bootstrap.rs: make the stage VISIBLE in the installer UI -----------
# The frontend renders ONLY stages present in the Manifest event (store.ts
# drops Stage events for unknown names), so push a synthetic StageInfo. The
# Rust stage LOOP iterates manifest.stages (unmodified) and never tries to run
# it as an install.ps1 stage — only the injected block above emits its events.
if grep -q 'Applying JARVIS' "$BR"; then
  echo "  bootstrap.rs: manifest stage row already present (idempotent)"
else
  perl -0777 -pi -e 's{stages: manifest\.stages\.clone\(\),}{stages: \{ let mut s = manifest.stages.clone(); s.push(crate::events::StageInfo \{ name: "jarvis-overlay".into(), title: "Applying JARVIS (branding + desktop)".into(), category: "install".into(), needs_user_input: false \}); s \},}g' "$BR"
  grep -q 'Applying JARVIS' "$BR" || { echo "ERROR: manifest stage row not injected — anchor changed upstream?" >&2; exit 1; }
  echo "  bootstrap.rs: 'Applying JARVIS' stage row added to the UI manifest"
fi

# --- 2c. bootstrap.rs: embedded-script helper + baked overlay ref -----------
if grep -q 'async fn jarvis_overlay_run' "$BR"; then
  echo "  bootstrap.rs: overlay helper already present (idempotent)"
else
  cat >> "$BR" <<'RUST'

/// JARVIS overlay stage runner (injected by the JARVIS overlay — not upstream).
/// The overlay scripts are EMBEDDED in the binary: a bare JARVIS-Setup.exe
/// downloaded to ~/Downloads has no loose resource files next to it, so
/// Tauri resource-dir loading can never work on Windows. At run time the
/// embedded script is written to the bootstrap cache dir and executed via the
/// same machinery that drives install.ps1.
const JARVIS_OVERLAY_PS1: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/jarvis-overlay.ps1"));
const JARVIS_OVERLAY_SH: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/jarvis-overlay.sh"));
/// Overlay ref baked at brand time by inject-overlay-stage.sh — the shipped
/// installer applies the exact overlay commit it was built/tested against.
const JARVIS_OVERLAY_REF: &str = "__JARVIS_OVERLAY_REF__";

async fn jarvis_overlay_run(
    app: &AppHandle,
    install_root: &std::path::Path,
    hermes_home: Option<&str>,
    emit_log: &impl Fn(&str),
) -> Result<()> {
    let (name, body) = if cfg!(target_os = "windows") {
        ("jarvis-overlay.ps1", JARVIS_OVERLAY_PS1)
    } else {
        ("jarvis-overlay.sh", JARVIS_OVERLAY_SH)
    };
    let dir = crate::paths::bootstrap_cache_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("create bootstrap cache dir {}: {e}", dir.display()))?;
    let script = dir.join(name);
    std::fs::write(&script, body).map_err(|e| anyhow!("write {}: {e}", script.display()))?;
    emit_log(&format!(
        "[jarvis] overlay via {} (ref {})",
        script.display(),
        JARVIS_OVERLAY_REF
    ));
    let script_args = vec![
        install_root.to_string_lossy().into_owned(),
        JARVIS_OVERLAY_REF.to_string(),
    ];
    let res = run_install_script(
        app,
        &script,
        &script_args,
        hermes_home,
        None,
        Some("jarvis-overlay".to_string()),
    )
    .await?;
    if res.exit_code == Some(0) {
        Ok(())
    } else {
        Err(anyhow!(
            "overlay script exit {:?}\n{}",
            res.exit_code,
            res.stderr.trim()
        ))
    }
}
RUST
  grep -q 'async fn jarvis_overlay_run' "$BR" || { echo "ERROR: failed to append overlay helper to bootstrap.rs" >&2; exit 1; }
  echo "  bootstrap.rs: overlay helper appended"
fi

# --- 2d. bootstrap.rs: reapply helper (used by update.rs's rebrand stage) ---
if grep -q 'jarvis_reapply_branding' "$BR"; then
  echo "  bootstrap.rs: reapply helper already present (idempotent)"
else
  cat >> "$BR" <<'RUST'

/// JARVIS: re-apply branding to the updated source so a following desktop
/// rebuild is branded (the Setup-path trailing re-apply — analogue of
/// update-jarvis.sh's post-pull apply). Runs apply.sh from the persistent
/// overlay checkout at <HERMES_HOME>/jarvis-agent via bash (Git Bash on
/// Windows). Best-effort: the caller logs failure and still rebuilds.
pub(crate) async fn jarvis_reapply_branding(install_root: &std::path::Path) -> Result<()> {
    let overlay = install_root
        .parent()
        .map(|p| p.join("jarvis-agent"))
        .ok_or_else(|| anyhow!("no parent dir for install_root"))?;
    let apply = overlay.join("apply.sh");
    if !apply.exists() {
        return Err(anyhow!("overlay apply.sh not found at {}", apply.display()));
    }
    let bash = jarvis_find_bash().ok_or_else(|| anyhow!("bash not found for JARVIS re-apply"))?;
    let apply_posix = apply.to_string_lossy().replace('\\', "/");
    let root_posix = install_root.to_string_lossy().replace('\\', "/");
    let status = tokio::process::Command::new(bash)
        .arg("-lc")
        .arg(format!("HERMES_SRC='{root_posix}' bash '{apply_posix}'"))
        .status()
        .await
        .map_err(|e| anyhow!("spawn bash apply.sh: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("apply.sh exited with {status}"))
    }
}

#[cfg(target_os = "windows")]
fn jarvis_find_bash() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            let p = if var == "LOCALAPPDATA" {
                PathBuf::from(base).join("Programs").join("Git").join("bin").join("bash.exe")
            } else {
                PathBuf::from(base).join("Git").join("bin").join("bash.exe")
            };
            if p.exists() {
                return Some(p);
            }
        }
    }
    which::which("bash").ok()
}

#[cfg(not(target_os = "windows"))]
fn jarvis_find_bash() -> Option<std::path::PathBuf> {
    which::which("bash").ok().or_else(|| {
        let p = std::path::PathBuf::from("/bin/bash");
        if p.exists() { Some(p) } else { None }
    })
}
RUST
  grep -q 'jarvis_reapply_branding' "$BR" || { echo "ERROR: failed to append reapply helper to bootstrap.rs" >&2; exit 1; }
  echo "  bootstrap.rs: reapply helper appended"
fi

# Bake the ref into the helper (first injection only — see idempotency note).
if grep -q '__JARVIS_OVERLAY_REF__' "$BR"; then
  perl -pi -e "s{__JARVIS_OVERLAY_REF__}{$REF}g" "$BR"
  echo "  bootstrap.rs: overlay ref baked -> $REF"
fi

# --- 3a. update.rs: 'rebrand' row in the synthetic update manifest ----------
# update.rs builds its own manifest (handoff → update → rebuild); without a
# row the rebrand stage's events are dropped by the UI (finding #3).
if [ -f "$UR" ] && ! grep -q '"rebrand", "Re-applying JARVIS' "$UR"; then
  perl -0777 -pi -e 's{(        stage_info\("update", "Downloading the latest version"\),)}{$1\n        stage_info("rebrand", "Re-applying JARVIS branding"),}g' "$UR"
  grep -q '"rebrand", "Re-applying JARVIS' "$UR" || { echo "ERROR: rebrand manifest row not injected — anchor changed upstream?" >&2; exit 1; }
  echo "  update.rs: 'rebrand' row added to the synthetic update manifest"
elif [ -f "$UR" ]; then
  echo "  update.rs: rebrand manifest row already present (idempotent)"
fi

# --- 3b. update.rs: manifest-scoped revert BEFORE `hermes update` -----------
# A clean tree fast-forwards with nothing to autostash: no per-update stash
# growth, no stash-apply conflicts (finding #19). Scoped to the manifest
# apply.sh writes; files in branding.exclude are never in the manifest, so
# operator-patched files are left alone. Best-effort: on any failure the
# upstream autostash path handles the dirty tree as before.
if [ -f "$UR" ] && ! grep -q 'JARVIS: revert branded files' "$UR"; then
  perl -0777 -pi -e 's{(    emit_stage\(&app, "update", StageState::Running, None, None\);)}{// --- JARVIS: revert branded files before `hermes update` (injected) ---\n    \{\n        let manifest_path = crate::paths::hermes_home().join(".jarvis").join("branded-files.txt");\n        if let Ok(list) = std::fs::read_to_string(&manifest_path) \{\n            let rels: Vec<String> = list.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();\n            if !rels.is_empty() \{\n                let mut cmd = std::process::Command::new("git");\n                cmd.arg("-C").arg(&install_root).args(["checkout", "--"]);\n                for r in &rels \{ cmd.arg(r); \}\n                match cmd.status() \{\n                    Ok(s) if s.success() => emit_log(&app, Some("update"), LogStream::Stdout, &format!("[jarvis] reverted \{\} branded file(s) for a clean pull", rels.len())),\n                    other => emit_log(&app, Some("update"), LogStream::Stdout, &format!("[jarvis] branded-file revert skipped (\{other:?\}) — autostash will handle the dirty tree")),\n                \}\n            \}\n        \}\n    \}\n\n$1}g' "$UR"
  grep -q 'JARVIS: revert branded files' "$UR" || { echo "ERROR: pre-update revert not injected — anchor changed upstream?" >&2; exit 1; }
  echo "  update.rs: manifest-scoped pre-update revert injected"
elif [ -f "$UR" ]; then
  echo "  update.rs: pre-update revert already present (idempotent)"
fi

# --- 3c. update.rs: rebrand stage before the desktop rebuild ----------------
if [ -f "$UR" ] && ! grep -q 'jarvis_reapply_branding' "$UR"; then
  perl -0777 -pi -e 's{(    emit_stage\(&app, "rebuild", StageState::Running, None, None\);)}{// --- JARVIS: re-apply branding before the rebuild so it builds branded ---\n    emit_stage(&app, "rebrand", StageState::Running, None, None);\n    match crate::bootstrap::jarvis_reapply_branding(&install_root).await \{\n        Ok(()) => emit_stage(&app, "rebrand", StageState::Succeeded, None, None),\n        Err(e) => \{\n            emit_log(&app, Some("rebrand"), LogStream::Stderr, &format!("[jarvis] re-apply failed (desktop may rebuild unbranded): \{e:#\}"));\n            emit_stage(&app, "rebrand", StageState::Failed, None, Some(format!("\{e:#\}")));\n        \}\n    \}\n\n$1}g' "$UR"
  grep -q 'jarvis_reapply_branding' "$UR" || { echo "ERROR: rebrand call not injected into update.rs — anchor changed upstream?" >&2; exit 1; }
  echo "  update.rs: rebrand stage injected before rebuild"
elif [ -f "$UR" ]; then
  echo "  update.rs: rebrand call already present (idempotent)"
fi

echo "  ✓ overlay stage wired (embedded scripts, visible stages, pinned ref $REF)"
