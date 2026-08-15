# Cutting a JARVIS release

Releases are cut by hand with `gh`; CI does the rest. There is exactly one rule
that matters, and it is not optional:

> **Create the release as a PRERELEASE. Never as latest.**

CI promotes it once every asset is verified. If you skip that, you take the
website down.

## Why

`installer-build.yml` builds `JARVIS-Setup.exe` / `.dmg` **on the
`release: published` event** — the assets are produced *by* the release, so a
newly created release is empty for the 30-60 minutes the build takes.

`https://xcerebro.ai/jarvis/` links the installers as
`releases/latest/download/JARVIS-Setup.exe`. If a brand-new, empty release is
already flagged "latest", that URL resolves to it and **404s** — the product
page's primary download buttons are dead for the entire build window. This is
not hypothetical; it happened on v1.1.2 and was caught only because someone
checked the live URLs by hand.

Cutting as a prerelease means `/latest` keeps pointing at the previous good
release until the new one is genuinely complete.

## The four assets

Every release must carry all four. Two are built, two are uploaded from `dist/`:

| Asset | Source | Used by |
| --- | --- | --- |
| `JARVIS-Setup.exe` | built by the `build` matrix | site "Download for Windows" |
| `JARVIS-Setup.dmg` | built by the `build` matrix | site "Download for Mac" |
| `jarvis-windows.ps1` | `dist/`, by the `scripts` job | site terminal panel |
| `jarvis-mac.sh` | `dist/`, by the `scripts` job | site terminal panel |

The two scripts used to be attached manually, so any release that forgot them
404'd the terminal-panel links. The `scripts` job now does it automatically —
do not upload them by hand.

## Procedure

1. **Check main is green.** CI, `desktop-build`, and `installer-build` should
   all be passing on the commit you are tagging. The daily canary means an
   upstream break is usually already visible; do not tag over a red build.

2. **Cut the release as a prerelease.**

   ```bash
   gh release create vX.Y.Z --prerelease \
     --target <commit-sha> \
     --title "JARVIS vX.Y.Z" \
     --notes-file notes.md
   ```

   `--prerelease` is the whole point. `--target` pins the exact commit rather
   than whatever `main` drifts to.

3. **Wait for `installer-build` on the `release` event.** It builds both
   installers, attaches them, attaches the two scripts, and then the `finalize`
   job:
   - asserts all four assets are listed,
   - asserts each is actually downloadable (listed ≠ downloadable),
   - promotes the release to latest,
   - re-checks all four `releases/latest/download/*` URLs.

   If any check fails the release **stays a prerelease** and `/latest` keeps
   serving the previous release. Fix the cause and re-run the workflow; nothing
   customer-facing broke in the meantime.

4. **Confirm the live page.** CI checks the GitHub URLs; this checks what a
   customer actually gets:

   ```bash
   curl -s https://xcerebro.ai/jarvis/ | grep -oE 'id="btn-(win|mac)" href="[^"]+"'

   for u in JARVIS-Setup.exe JARVIS-Setup.dmg jarvis-windows.ps1 jarvis-mac.sh; do
     printf '%s -> ' "$u"
     curl -s -o /dev/null -w '%{http_code}\n' -L \
       "https://github.com/xcerebroai/jarvis-agent/releases/latest/download/$u"
   done
   ```

   All four must be `200`, and `/latest` must resolve to the new tag:

   ```bash
   curl -s -o /dev/null -w '%{redirect_url}\n' \
     https://github.com/xcerebroai/jarvis-agent/releases/latest
   ```

   A 404 immediately after promotion is usually CDN lag — retry with a
   cache-buster before assuming it is broken.

## If you have to fix a release after the fact

Demote it rather than leaving a broken "latest" in place; `/latest` falls back
to the previous good release straight away:

```bash
gh release edit vX.Y.Z --prerelease
```

Then fix the cause, re-run `installer-build` on the tag, and let `finalize`
promote it again.

## Do not

- **Do not** create a release without `--prerelease`.
- **Do not** promote by hand while a build is still running — that is exactly
  the failure `finalize` exists to prevent.
- **Do not** upload `jarvis-windows.ps1` / `jarvis-mac.sh` manually; the
  `scripts` job owns them, and a manual copy will drift from `dist/`.
- **Do not** delete and re-create a tag to "retry". Demote, fix, re-run.

## Related

- `docs/SIGNING.md` — the installers are unsigned; the signing and notarization
  machinery is in place and dormant, waiting on credentials.
- `tests/brand_scan.py` + `branding-known-ok.txt` — the brand-leak gate that
  runs on every apply and in CI.
