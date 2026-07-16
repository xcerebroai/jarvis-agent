//! JARVIS DMG hop (injected by the JARVIS overlay — not upstream; macOS only).
//!
//! Double-clicking JARVIS-Setup inside the mounted .dmg runs it from a
//! read-only /Volumes mount, so the volume can't eject while the installer
//! is open — users hit "Resource busy" or a stuck disk image (reproduced
//! live 2026-07-16 with the v1.1.0 dmg). Fix, mirroring the intent of
//! upstream's `copy_self_to_hermes_home` (which stages only the bare binary
//! for `--update` handoffs and can't relaunch a .app):
//!
//!   1. On launch, detect we're running from a read-only /Volumes mount.
//!   2. `ditto` the whole .app bundle to the bootstrap cache dir (a stable,
//!      always-writable JARVIS staging path), clear quarantine, re-sign
//!      ad-hoc if the copy's signature doesn't verify.
//!   3. Relaunch the staged copy via `open -n` forwarding the original args
//!      plus `--jarvis-eject-dmg=<volume>`, then exit this DMG instance.
//!   4. The staged instance ejects the volume BEFORE the Tauri UI starts:
//!      `hdiutil detach` with retries (the DMG instance takes a moment to
//!      die), then a force-detach fallback.
//!
//! Every failure degrades to today's behavior (keep running from the DMG),
//! logged — never a failed install. On non-macOS this module is a no-op.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

/// Arg prefix carried by the staged relaunch. Never collides with upstream's
/// exact-match flags (`--update`, `--reinstall`, `--repair`).
#[cfg(target_os = "macos")]
const EJECT_FLAG: &str = "--jarvis-eject-dmg=";

/// Entry point, called at the very top of `run()` before the Tauri builder —
/// ahead of the launcher fast path so even "already installed" DMG launches
/// hop out and eject cleanly.
pub fn hop_or_eject() {
    #[cfg(target_os = "macos")]
    {
        // Staged-relaunch side: eject the volume our parent ran from.
        if let Some(volume) = std::env::args().skip(1).find_map(|a| {
            a.strip_prefix(EJECT_FLAG).map(PathBuf::from)
        }) {
            eject_volume(&volume);
            return;
        }
        // DMG side: hop to local staging and exit.
        if let Some((bundle, volume)) = dmg_bundle_of_current_exe() {
            tracing::info!(?bundle, ?volume, "running from a read-only DMG — staging local copy");
            match hop_to_staging(&bundle, &volume) {
                Ok(()) => {
                    tracing::info!("staged relaunch spawned; exiting DMG instance");
                    std::process::exit(0);
                }
                Err(err) => {
                    // Degrade to current behavior: run from the DMG (the user
                    // just can't eject until they quit — exactly today's UX).
                    tracing::warn!(?err, "DMG hop failed; continuing from the mounted image");
                }
            }
        }
    }
}

/// Returns (bundle, volume) iff the running exe lives in a .app under a
/// read-only /Volumes mount. The read-only probe (EROFS on create) is what
/// distinguishes a mounted disk image from an app legitimately copied onto a
/// writable external volume.
#[cfg(target_os = "macos")]
fn dmg_bundle_of_current_exe() -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let mut comps = exe.components();
    use std::path::Component;
    if comps.next() != Some(Component::RootDir) {
        return None;
    }
    if comps.next().map(|c| c.as_os_str()) != Some(std::ffi::OsStr::new("Volumes")) {
        return None;
    }
    let name = comps.next()?;
    let volume = PathBuf::from("/Volumes").join(name.as_os_str());
    let bundle = exe
        .ancestors()
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))?
        .to_path_buf();

    // Probe writability at the volume root. Only EROFS means "disk image".
    let probe = volume.join(".jarvis-rw-probe");
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            None
        }
        Err(e) if e.raw_os_error() == Some(libc_erofs()) => Some((bundle, volume)),
        Err(_) => None,
    }
}

/// EROFS without a libc dependency (stable on every macOS target we build).
#[cfg(target_os = "macos")]
const fn libc_erofs() -> i32 {
    30
}

/// Copy the bundle to `<bootstrap-cache>/<bundle name>`, make it launchable,
/// and relaunch it with the original args plus the eject flag.
#[cfg(target_os = "macos")]
fn hop_to_staging(bundle: &Path, volume: &Path) -> std::io::Result<()> {
    use std::process::Command;

    let staging_dir = crate::paths::bootstrap_cache_dir();
    std::fs::create_dir_all(&staging_dir)?;
    let staged = staging_dir.join(bundle.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "bundle has no file name")
    })?);

    // Stale copy from an earlier hop: replace wholesale so we never launch a
    // mixed-version bundle.
    if staged.exists() {
        std::fs::remove_dir_all(&staged)?;
    }

    // ditto preserves resource forks, permissions, and the code signature.
    let st = Command::new("/usr/bin/ditto").arg(bundle).arg(&staged).status()?;
    if !st.success() {
        return Err(std::io::Error::other(format!("ditto exited with {st}")));
    }

    // Same launchability repair upstream applies to its staged update helper
    // (paths.rs repair_macos_installer_helper): strip quarantine, then re-sign
    // ad-hoc only if the signature no longer verifies.
    let _ = Command::new("/usr/bin/xattr").args(["-cr"]).arg(&staged).status();
    let verify = Command::new("/usr/bin/codesign").arg("--verify").arg(&staged).status();
    if !matches!(verify, Ok(s) if s.success()) {
        let _ = Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "--sign", "-"])
            .arg(&staged)
            .status();
    }

    // Relaunch detached from this process; forward the user's original args
    // (e.g. --reinstall) so the staged instance behaves identically.
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg("-n").arg(&staged).arg("--args");
    cmd.arg(format!("{EJECT_FLAG}{}", volume.display()));
    for a in std::env::args().skip(1) {
        cmd.arg(a);
    }
    let st = cmd.status()?;
    if !st.success() {
        return Err(std::io::Error::other(format!("open exited with {st}")));
    }

    // Brief grace so LaunchServices registers the child before we exit
    // (mirrors the launcher fast path's post-spawn sleep).
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}

/// Detach the DMG volume the parent instance ran from. Synchronous and
/// bounded: it must finish before the Tauri builder starts, because the
/// launcher fast path can exit the process within milliseconds of setup —
/// a background thread would be killed before the volume ejects. The parent
/// exits right after spawning us, so try 1-2 normally succeeds; the force
/// fallback covers Finder windows or Spotlight holding the mount.
#[cfg(target_os = "macos")]
fn eject_volume(volume: &Path) {
    use std::process::Command;

    if !volume.starts_with("/Volumes") || !volume.exists() {
        tracing::info!(?volume, "DMG volume already gone; nothing to eject");
        return;
    }
    for attempt in 1..=12u32 {
        let st = Command::new("/usr/bin/hdiutil").arg("detach").arg(volume).status();
        if matches!(st, Ok(s) if s.success()) {
            tracing::info!(?volume, attempt, "DMG ejected cleanly");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let st = Command::new("/usr/bin/hdiutil")
        .args(["detach", "-force"])
        .arg(volume)
        .status();
    match st {
        Ok(s) if s.success() => tracing::info!(?volume, "DMG force-ejected"),
        other => tracing::warn!(?volume, ?other, "could not eject DMG volume"),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn eject_flag_parses_volume_with_spaces() {
        let arg = format!("{EJECT_FLAG}/Volumes/JARVIS Setup");
        let vol = arg.strip_prefix(EJECT_FLAG).map(PathBuf::from).unwrap();
        assert_eq!(vol, PathBuf::from("/Volumes/JARVIS Setup"));
    }

    #[test]
    fn non_volumes_exe_is_not_a_dmg() {
        // The real exe under target/ or /Applications must never trigger a hop.
        assert!(dmg_bundle_of_current_exe().is_none());
    }
}
