# Code signing & notarization

The installers this repo publishes — `JARVIS-Setup.exe` and `JARVIS-Setup.dmg` —
are currently **unsigned**. They work, but the first launch shows a scary OS
warning: SmartScreen on Windows ("Windows protected your PC"), Gatekeeper on
macOS ("Apple could not verify "JARVIS" is free of malware…", cleared via
System Settings → Privacy & Security → Open Anyway). The xcerebro.ai/jarvis
page tells users how to click through, which is the honest short-term answer
but costs real installs.

**The macOS bundle must always be at least ad-hoc signed.** The unsigned build
path in `installer-build.yml` sets `APPLE_SIGNING_IDENTITY: "-"` so Tauri
ad-hoc signs the whole bundle before building the dmg. Without it Tauri skips
codesign and the app carries only the Rust linker's implicit signature — no
bundle seal — which Gatekeeper treats as an *invalid* signature and blocks
with the unbypassable **"JARVIS is damaged and can't be opened"** dialog
(shipped in ≤ v1.1.6; measured on macOS 26.5.2, fixed in v1.1.7). A
"Verify app signature inside dmg" CI step now fails any build whose bundle
does not pass `codesign --verify --deep --strict`.

Upstream's `Hermes-Setup.dmg` avoids all of this by being Developer ID signed
**and notarized** (verified by inspection: `spctl` says "accepted,
source=Notarized Developer ID") — that is the end state the credentials below
buy; ad-hoc signing only restores the bypassable warning, it does not remove
it.

`.github/workflows/installer-build.yml` already contains the full signing and
notarization machinery. **It is dormant**: every path is gated on repository
secrets, and while those secrets are absent the workflow logs why it skipped and
ships the unsigned artifact exactly as it does today. Nothing here changes CI
until someone adds credentials.

---

## What to buy / enroll in

### macOS — Apple Developer Program

- **Apple Developer Program** — $99/year, <https://developer.apple.com/programs/>.
  An individual enrollment is fine; an Organization enrollment needs a D-U-N-S
  number and takes longer, but puts the company name (not a person's) in the
  Gatekeeper prompt.
- From the developer portal, create a **Developer ID Application** certificate.
  This is the only kind that notarizes for distribution outside the App Store —
  a "Mac Development" or "Apple Distribution" certificate will be rejected, and
  the workflow fails fast with that message rather than burning a build.
- Export it from Keychain Access as a `.p12` **with a password** (Keychain
  Access → My Certificates → right-click → Export).
- Create an **app-specific password** for notarization at
  <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
  Your normal Apple ID password will not work.

### Windows — code-signing certificate

- An **OV** (Organization Validation) certificate is the cheaper option
  (~$200-400/year) from DigiCert, Sectigo, SSL.com, Certum and others. It signs
  correctly, but SmartScreen reputation still has to accumulate over downloads,
  so early users may keep seeing the warning for a while.
- An **EV** (Extended Validation) certificate (~$400-700/year) gets
  **immediate SmartScreen reputation**, which is usually the reason to pay the
  difference. EV keys ship on a hardware token or in a cloud HSM, so they often
  **cannot** be used as a `.p12` file in CI — check with the issuer before
  buying if the file-based path below is the plan.
- Since June 2023 the CA/Browser Forum requires all code-signing private keys to
  live on FIPS-140-2 hardware, so a plain downloadable `.p12` is increasingly
  something only resellers of older OV products offer.
- **Azure Trusted Signing** (~$10/month) is the pragmatic alternative: Microsoft
  holds the key, there is no token to manage, and this workflow already supports
  it. Requires a verified organization (3+ years of history, or extra vetting).

---

## Which secrets to set

Set these under **Settings → Secrets and variables → Actions → New repository
secret**. Each platform has two independent paths; configure **one** per
platform. If both are set, the pre-existing path wins and the other logs that it
deferred, so the artifact is never signed twice.

### macOS — path A: notarytool with a certificate file

All five are required. A partial set counts as absent, so a half-finished setup
keeps producing unsigned builds instead of failing the release.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | The Developer ID `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password used when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email on the developer account |
| `APPLE_TEAM_ID` | 10-character Team ID from the developer portal |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password created above |

Encode the certificate:

```bash
base64 -i DeveloperID.p12 | pbcopy      # macOS
base64 -w0 DeveloperID.p12              # Linux
```

### macOS — path B: Tauri with an App Store Connect API key

Pre-existing. Uses `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`,
`APPLE_API_KEY_PATH`, `APPLE_TEAM_ID`, and lets Tauri sign and notarize during
the build. Prefer this one if you already have an API key — API-key auth does
not break when the Apple ID gets a new 2FA device.

### Windows — path A: certificate file

| Secret | What it is |
| --- | --- |
| `WINDOWS_CERT_P12` | The `.pfx`/`.p12`, base64-encoded |
| `WINDOWS_CERT_PASSWORD` | Its password |

### Windows — path B: Azure Trusted Signing

Pre-existing. Uses `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TS_ENDPOINT`, `AZURE_TS_ACCOUNT`, `AZURE_TS_CERT_PROFILE`.

---

## What the workflow does once credentials exist

**macOS.** The `.p12` is imported into a throwaway keychain created in
`RUNNER_TEMP` — never the default keychain, and deleted in an `always()` cleanup
step so it cannot outlive the job. This happens **before** the Tauri build,
which matters: notarization inspects the `.app` inside the `.dmg`, and Apple
rejects a bundle that is only ad-hoc signed. Signing the outer disk image
afterwards does not fix that. Tauri then signs the app with the Developer ID
identity, the resulting dmg is signed, submitted with `notarytool submit --wait`,
and the ticket is stapled so the installer opens offline without a round trip to
Apple.

**Windows.** The staged `JARVIS-Setup.exe` is signed with `signtool` from the
newest Windows SDK on the runner, SHA-256, with an RFC-3161 timestamp — the
timestamp is what keeps already-downloaded installers trusted after the
certificate expires.

---

## Verifying the first signed build

Download the artifact from the workflow run (do **not** test the file straight
out of the build directory — the point is to check what users receive).

### macOS

```bash
# The ticket is stapled — this must succeed with no network.
xcrun stapler validate JARVIS-Setup.dmg

# Gatekeeper's own verdict. Want: "accepted" and "source=Notarized Developer ID".
spctl -a -vv -t install JARVIS-Setup.dmg

# Inspect the signature on the app inside the mounted image.
hdiutil attach JARVIS-Setup.dmg
codesign -dvvv --verbose=4 "/Volumes/JARVIS/JARVIS.app"
codesign --verify --deep --strict --verbose=2 "/Volumes/JARVIS/JARVIS.app"
hdiutil detach "/Volumes/JARVIS"
```

`Authority=Developer ID Application: …` and a `Timestamp=` line mean it is
correct. If notarization failed, get the reason with the submission ID from the
build log:

```bash
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

### Windows

```powershell
# Want: "Successfully verified" and a timestamp entry.
signtool verify /pa /v JARVIS-Setup.exe

# Or without the SDK installed:
Get-AuthenticodeSignature .\JARVIS-Setup.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

`Status: Valid` is the pass condition. SmartScreen reputation is separate from
signature validity: with an OV certificate the warning can persist until enough
downloads accumulate, which is expected and not a signing failure.

### The real test

Download both installers on a machine that has never run JARVIS and open them
the way a customer would. That is the only check that tells you the warnings are
actually gone.

Once they are, drop the "isn't code-signed yet" sentence and the two
SmartScreen/Gatekeeper notes from the download section of the JARVIS page
(`docs/jarvis/index.html` in the `Xcerebro-Agents` repo).
