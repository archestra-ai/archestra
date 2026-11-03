# Desktop device enrollment

The desktop app is named from the deployment's `appName`. The browser downloads
one signed desktop package, then opens the same installed app using a short-lived
`archestra-device://enroll` handoff. The app reviews the deployment and account
before enrollment and saves its scoped device credential using OS encryption.
There is no second setup-file download in the normal flow.

The protocol handler only accepts `version=1`, an encoded HTTPS deployment origin
(localhost HTTP is permitted for development), and a one-time enrollment code.
It cannot carry commands, filesystem paths, tool configuration or a device bearer
token. The proof stays in the main process and is not logged or sent to the
renderer. Existing `.archestra` files remain a developer compatibility path.

## Release builds

From `platform/`:

```sh
pnpm --dir device-mcp-desktop build --app-name "Example AI"
pnpm --dir device-mcp-desktop build --app-name "Example AI" --x64
pnpm --dir device-mcp-desktop build --app-name "Example AI" --win32
```

`ARCHESTRA_DESKTOP_APP_NAME` can supply the same app name in a build pipeline.
The name must match the deployment's configured app name exactly. Its product
name, native executable, bundle, window, menus and archive filename all follow
that value. Archives include a short hash of the exact app name so normalized
slugs cannot collide across brands.

macOS release prerequisites:

- A macOS build host with Xcode command line tools.
- `ARCHESTRA_DESKTOP_MAC_SIGNING_IDENTITY`: an available, valid
  `Developer ID Application: ... (TEAMID)` identity.
- `ARCHESTRA_DESKTOP_MAC_NOTARY_PROFILE`: an already provisioned notarization
  Keychain profile. The script does not create credentials or identities.

The release pipeline signs the modified Electron app with hardened runtime,
notarizes and staples it, verifies the expected Developer ID and timestamp, and
requires Gatekeeper's `Notarized Developer ID` assessment. It also extracts the
finished ZIP and repeats signature, ticket and Gatekeeper checks before exposing
a manifest. The prior Electron vendor signature is not treated as a signature of
the modified app.

Windows releases must run on Windows and require an installed code-signing
certificate with its private key:

- `ARCHESTRA_DESKTOP_WINDOWS_CERTIFICATE_SHA1`: its certificate thumbprint.
- `ARCHESTRA_DESKTOP_WINDOWS_TIMESTAMP_SERVER`: an HTTPS timestamp service.

Every packaged executable, DLL and native module must have a valid Authenticode
signature from that certificate and a timestamp. SmartScreen reputation is a
separate operating-system decision; a signature is not a promise to suppress it.

Release builds fail closed if prerequisites or native verification are missing.
Only successful release builds write to `dist/artifacts`, with manifests
attesting their brand and native verification. Failed builds do not produce a
new downloadable manifest. Signing accesses the configured signing identity;
notarization submits the app to Apple. Those steps must be authorized in the
release environment before running a configured release build.

## Development packages

`--development` explicitly creates untrusted packages under
`dist/development`, outside the release download directory. A development macOS
bundle is re-signed ad hoc and checked for internal integrity to avoid retaining
an invalid vendor signature after modification. This is **not** Developer ID
signing, notarization or Gatekeeper trust. It does not bypass Gatekeeper or change
quarantine/security settings. Development builds do not declare a browser protocol handler by default and
cannot be offered as normal end-user downloads. To prepare the actual local
browser handoff for an explicitly authorized test, add `--browser-handoff`.
That flag includes the OS protocol declaration in the development bundle; it
still does not launch the app or change OS registration during the build.
Launching/installing that bundle can register the handler, so get separate
approval for the handler before exercising it. The package remains ad hoc,
unnotarized, isolated in `dist/development`, and rejected by normal downloads.

## Installation authorization

The signed macOS app declares the `archestra-device` protocol for normal OS
installation. On Windows, the installed app offers an explicit native approval
to register browser connections for the current user. Launching/installing this
release therefore has a different scope from the earlier prototype that declared
no handler. Get approval before exercising that installation or registration.
No login item is installed. Opening the app restores its approved saved device
connection; closing its window keeps it running until Quit.

Production update/signing identity must remain stable so the OS can recognize
the app and its encrypted credential storage across updates.
