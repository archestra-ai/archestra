#!/usr/bin/env bash
# Signs the two macOS `archestra` binaries in DIR with the Developer ID
# Application certificate of Archestra Limited, has Apple notarize them, and
# checks the result. The files are changed in place.
#
# The sign-macos job of build-archestra-cli.yml runs this. It also runs on a
# Mac, to test the signing secrets before a release depends on them.
#
# Environment:
#   SIGNING_CERTIFICATE_BASE64    the certificate and its private key, a .p12 file in base64
#   SIGNING_CERTIFICATE_PASSWORD  the password of that .p12 file
#   APPLE_TEAM_ID                 the Apple team the certificate belongs to
#   APPLE_ID                      the Apple ID that submits the files for notarization
#   APPLE_PASSWORD                an app-specific password of that Apple ID
#
# The signing identity is the one Developer ID Application identity in the
# .p12 file; the requirement check below makes sure it belongs to that team.
#
# The signing identifier must never change: macOS keeps a program's privacy
# permissions (Screen Recording, Accessibility) across updates only while the
# identifier and the team stay the same.
set -euo pipefail

readonly IDENTIFIER="ai.archestra.cli"
readonly FILES=(archestra-darwin-arm64 archestra-darwin-x86_64)
# Apple's Developer ID G2 intermediate, which issued the certificate. codesign
# needs it to build the chain. The GitHub macOS runner image installs it, a Mac
# usually does not, and the .p12 does not carry it. Downloaded from
# https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer, SHA-256
# f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a.
readonly INTERMEDIATE="$(dirname "${BASH_SOURCE[0]}")/apple-developer-id-g2-ca.pem"

dist="${1:?usage: archestra-cli-sign-macos.sh DIR}"
: "${SIGNING_CERTIFICATE_BASE64:?}" "${SIGNING_CERTIFICATE_PASSWORD:?}" "${APPLE_TEAM_ID:?}" "${APPLE_ID:?}" "${APPLE_PASSWORD:?}"
# Signed with a Developer ID Application certificate (the two Apple OIDs) of
# this team, under this identifier.
readonly REQUIREMENT="=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"${APPLE_TEAM_ID}\" and identifier \"${IDENTIFIER}\""

# Exactly the two macOS binaries, so nothing else gets signed or skipped.
found="$(ls -A "$dist" | paste -sd, -)"
expected="$(IFS=,; echo "${FILES[*]}")"
if [[ "$found" != "$expected" ]]; then
  echo "::error::Expected ${expected} in ${dist}, found: ${found}"
  exit 1
fi

umask 077
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/archestra-sign.XXXXXX")"
keychain="${work}/signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"

# The temporary keychain goes first in the search list, because codesign
# looks for the identity and the intermediate there. The old list comes back
# on exit, and the keychain with the private key is deleted.
original_keychains=()
while IFS= read -r path; do
  original_keychains+=("$path")
done < <(security list-keychains -d user | xargs -n1)
cleanup() {
  security list-keychains -d user -s ${original_keychains[@]+"${original_keychains[@]}"} || true
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
printf '%s' "$SIGNING_CERTIFICATE_BASE64" | base64 --decode > "${work}/certificate.p12"
security import "${work}/certificate.p12" -k "$keychain" -P "$SIGNING_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
rm "${work}/certificate.p12"
security import "$INTERMEDIATE" -k "$keychain"
# Lets codesign use the key without a dialog, which nobody could answer.
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" > /dev/null
security list-keychains -d user -s "$keychain" ${original_keychains[@]+"${original_keychains[@]}"}

# The identity by its SHA-1 hash: exactly one valid Developer ID Application
# identity in the temporary keychain.
identities="$(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application: / {print $2}')"
if [[ -z "$identities" || "$identities" == *$'\n'* ]]; then
  echo "::error::Expected one valid Developer ID Application identity in the .p12 file"
  exit 1
fi

# Hardened runtime and a secure timestamp: notarization requires both, so an
# "Accepted" status below also confirms them.
for file in "${FILES[@]}"; do
  codesign --force --options runtime --timestamp --identifier "$IDENTIFIER" \
    --keychain "$keychain" --sign "$identities" "${dist}/${file}"
  codesign --verify --strict --verbose=2 -R "$REQUIREMENT" "${dist}/${file}"
done

# One submission for both files. A bare binary cannot carry the notarization
# ticket (no stapling), so macOS asks Apple online when the file is first run.
ditto -c -k "$dist" "${work}/archestra-macos.zip"
xcrun notarytool submit "${work}/archestra-macos.zip" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 20m --output-format json | tee "${work}/notarization.json" || true
echo
# notarytool's exit status alone does not say Apple accepted the files: only
# the status "Accepted" does.
submission="$(jq -r '.id // empty' "${work}/notarization.json" 2>/dev/null || true)"
status="$(jq -r '.status // empty' "${work}/notarization.json" 2>/dev/null || true)"
if [[ "$status" != "Accepted" ]]; then
  echo "::error::Notarization did not succeed (status: ${status:-none})"
  if [[ -n "$submission" ]]; then
    xcrun notarytool log "$submission" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
  fi
  exit 1
fi
echo "Signed and notarized: ${FILES[*]} (submission ${submission})"
