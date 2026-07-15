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

echo "  ✓ overlay stage wired"
