# JARVIS appearance default

Update-safe desktop feature that makes the built-in **JARVIS** palette the platform default.

## Behavior

- First launch paints JARVIS immediately, before React mounts.
- JARVIS appears in Appearance as a built-in theme.
- Valid global and per-profile user selections remain authoritative and persist normally.
- Missing, retired, or invalid stored themes fall back to JARVIS.
- **Settings → Reset to defaults** clears theme overrides and repaints JARVIS in the current and peer windows.
- The palette includes explicit sidebar and chat-bubble fallbacks so styling remains complete without the Command Center plugin.

## Update lifecycle

`apply-feature.sh apply` applies the focused tracked-file patch. `update-jarvis.sh` reverts it before pulling upstream; `apply.sh` reapplies it afterward. Drift fails loudly rather than leaving a partial default.

```bash
HERMES_SRC=/path/to/hermes-agent bash features/jarvis-appearance/apply-feature.sh apply
HERMES_SRC=/path/to/hermes-agent bash features/jarvis-appearance/apply-feature.sh verify
HERMES_SRC=/path/to/hermes-agent bash features/jarvis-appearance/apply-feature.sh revert
```
