#!/usr/bin/env bash
# inject-overlay-stage.sh — wire the JARVIS overlay stage into the Tauri app.
#
# Called by brand-installer.sh. Three idempotent injections:
#   1. Copy the bundled overlay scripts into src-tauri/resources/.
#   2. Declare them in tauri.conf.json  bundle.resources  so they ship.
#   3. Add ~20 lines of Rust to bootstrap.rs: after the upstream stage loop
#      (before Complete) run the overlay script via the existing
#      run_install_script machinery, streamed as a "jarvis-overlay" stage.
#
# Upstream install.ps1 / install.sh are NEVER modified — only the Tauri app
# (which we own the branded build of) gets the injected call.
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:?usage: inject-overlay-stage.sh /path/to/hermes-agent}"
APP="$SRC/apps/bootstrap-installer"
TAURI="$APP/src-tauri"
[ -d "$TAURI" ] || { echo "ERROR: $TAURI not found." >&2; exit 1; }

# --- 1. Bundle the overlay scripts as resources -----------------------------
mkdir -p "$TAURI/resources"
cp -f "$OVERLAY_DIR/installer/overlay-stage/jarvis-overlay.sh"  "$TAURI/resources/jarvis-overlay.sh"
cp -f "$OVERLAY_DIR/installer/overlay-stage/jarvis-overlay.ps1" "$TAURI/resources/jarvis-overlay.ps1"
echo "  overlay scripts -> src-tauri/resources/"

# --- 2. Declare resources in tauri.conf.json --------------------------------
TC="$TAURI/tauri.conf.json"
if grep -q 'resources/jarvis-overlay' "$TC"; then
  echo "  tauri.conf.json: resources already declared (idempotent)"
else
  perl -0777 -pi -e 's/("bundle":\s*\{\s*\n\s*"active":\s*true,)/$1\n    "resources": ["resources\/jarvis-overlay.ps1", "resources\/jarvis-overlay.sh"],/' "$TC"
  grep -q 'resources/jarvis-overlay' "$TC" || { echo "ERROR: failed to add bundle.resources to tauri.conf.json" >&2; exit 1; }
  echo "  tauri.conf.json: bundle.resources declared"
fi

# --- 3. Inject the Rust call + helper into bootstrap.rs ---------------------
BR="$TAURI/src/bootstrap.rs"
# 3a. Call block — inserted right after install_root is computed.
if grep -q 'JARVIS overlay stage (injected' "$BR"; then
  echo "  bootstrap.rs: overlay call already present (idempotent)"
else
  perl -0777 -pi -e 's{(    let install_root = PathBuf::from\(&hermes_home\)\.join\("hermes-agent"\);)}{$1\n    // --- JARVIS overlay stage (injected by the JARVIS overlay; upstream untouched) ---\n    // Layer branding + branded desktop + JARVIS shortcuts on top of the pristine\n    // install install.ps1 produced. Runs before Complete so a failure here surfaces\n    // as a failed install, never a half-branded one.\n    \{\n        let started = Instant::now();\n        emit_event(&app, BootstrapEvent::Stage \{ name: "jarvis-overlay".into(), state: StageState::Running, duration_ms: None, result: None, error: None \});\n        match jarvis_overlay_run(&app, &install_root, args.hermes_home.as_deref(), &emit_log).await \{\n            Ok(()) => emit_event(&app, BootstrapEvent::Stage \{ name: "jarvis-overlay".into(), state: StageState::Succeeded, duration_ms: Some(started.elapsed().as_millis() as u64), result: None, error: None \}),\n            Err(e) => \{\n                let msg = format!("JARVIS overlay stage failed: \{e:#\}");\n                emit_event(&app, BootstrapEvent::Stage \{ name: "jarvis-overlay".into(), state: StageState::Failed, duration_ms: Some(started.elapsed().as_millis() as u64), result: None, error: Some(msg.clone()) \});\n                emit_event(&app, BootstrapEvent::Failed \{ stage: Some("jarvis-overlay".into()), error: msg.clone() \});\n                return Err(anyhow!(msg));\n            \}\n        \}\n    \}\n}g' "$BR"

  grep -q 'JARVIS overlay stage (injected' "$BR" || { echo "ERROR: overlay call block not injected — anchor changed upstream?" >&2; exit 1; }
  echo "  bootstrap.rs: overlay call injected"
fi

# 3b. Helper fn — appended at EOF.
if grep -q 'async fn jarvis_overlay_run' "$BR"; then
  echo "  bootstrap.rs: overlay helper already present (idempotent)"
else
  cat >> "$BR" <<'RUST'

/// JARVIS overlay stage runner (injected by the JARVIS overlay — not upstream).
/// Resolves the bundled overlay script (jarvis-overlay.ps1 on Windows,
/// jarvis-overlay.sh elsewhere) from the app resource dir and runs it through
/// the same install-script machinery, passing install_root as its argument.
async fn jarvis_overlay_run(
    app: &AppHandle,
    install_root: &std::path::Path,
    hermes_home: Option<&str>,
    emit_log: &impl Fn(&str),
) -> Result<()> {
    use tauri::Manager;
    let script_name = if cfg!(target_os = "windows") {
        "jarvis-overlay.ps1"
    } else {
        "jarvis-overlay.sh"
    };
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| anyhow!("resolve resource_dir: {e}"))?;
    let script = dir.join("resources").join(script_name);
    if !script.exists() {
        return Err(anyhow!(
            "bundled JARVIS overlay script not found at {}",
            script.display()
        ));
    }
    emit_log(&format!("[jarvis] overlay via {}", script.display()));
    let res = run_install_script(
        app,
        &script,
        &[install_root.to_string_lossy().into_owned()],
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

# --- 4. Trailing re-apply on self-update (update.rs) ------------------------
# The desktop's "Update" hands off to `--update` -> update::run_update, which
# pulls upstream then rebuilds apps/desktop — from now-unbranded source. Inject
# a re-apply of the persistent overlay checkout's apply.sh BEFORE that rebuild,
# so the rebuilt desktop stays JARVIS. Mirrors update-jarvis.sh's post-pull
# apply; uses the checkout at <HERMES_HOME>/jarvis-agent (no bundled-resource
# dependency, since --update runs the staged bare exe).
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

# Inject the re-apply call into update.rs, before the rebuild stage.
UR="$TAURI/src/update.rs"
if [ -f "$UR" ] && ! grep -q 'jarvis_reapply_branding' "$UR"; then
  perl -0777 -pi -e 's{(    emit_stage\(&app, "rebuild", StageState::Running, None, None\);)}{// --- JARVIS: re-apply branding before the rebuild so it builds branded ---\n    emit_stage(&app, "rebrand", StageState::Running, None, None);\n    match crate::bootstrap::jarvis_reapply_branding(&install_root).await \{\n        Ok(()) => emit_stage(&app, "rebrand", StageState::Succeeded, None, None),\n        Err(e) => \{\n            emit_log(&app, Some("rebrand"), LogStream::Stderr, &format!("[jarvis] re-apply failed (desktop may rebuild unbranded): \{e:#\}"));\n            emit_stage(&app, "rebrand", StageState::Failed, None, Some(format!("\{e:#\}")));\n        \}\n    \}\n\n$1}g' "$UR"
  grep -q 'jarvis_reapply_branding' "$UR" || { echo "ERROR: failed to inject re-apply into update.rs (anchor changed upstream?)" >&2; exit 1; }
  echo "  update.rs: trailing re-apply injected before rebuild"
elif [ -f "$UR" ]; then
  echo "  update.rs: re-apply already present (idempotent)"
fi

echo "  ✓ overlay stage wired"
