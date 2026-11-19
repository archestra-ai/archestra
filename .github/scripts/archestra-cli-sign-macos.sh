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
#   APPLE_ID                      the Apple ID that submits the files for notarization
#   APPLE_PASSWORD                an app-specific password of that Apple ID
#
# The signing identifier must never change: macOS keeps a program's privacy
# permissions (Screen Recording, Accessibility) across updates only while the
# identifier and the team stay the same.
set -euo pipefail

readonly TEAM_ID="3WZ64G7AY2"
readonly IDENTITY="Developer ID Application: Archestra Limited (${TEAM_ID})"
readonly IDENTIFIER="ai.archestra.cli"
readonly FILES=(archestra-darwin-arm64 archestra-darwin-x86_64)
# Apple's Developer ID G2 intermediate, which issued the certificate. codesign
# needs it to build the chain and macOS does not ship it. Downloaded from
# https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer, SHA-256
# f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a.
INTERMEDIATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/apple-developer-id-g2-ca.pem"
readonly INTERMEDIATE

dist="${1:?usage: archestra-cli-sign-macos.sh DIR}"
: "${SIGNING_CERTIFICATE_BASE64:?}" "${SIGNING_CERTIFICATE_PASSWORD:?}" "${APPLE_ID:?}" "${APPLE_PASSWORD:?}"

# Exactly the two macOS binaries, so nothing else gets signed or skipped.
found="$(cd "$dist" && find . -mindepth 1 -maxdepth 1 -print | sed 's|^\./||' | sort | paste -sd, -)"
expected="$(printf '%s\n' "${FILES[@]}" | sort | paste -sd, -)"
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
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line#\"}"
  original_keychains+=("${line%\"}")
done < <(security list-keychains -d user)
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

# Hardened runtime and a secure timestamp: notarization requires both.
for file in "${FILES[@]}"; do
  codesign --force --options runtime --timestamp --identifier "$IDENTIFIER" \
    --keychain "$keychain" --sign "$IDENTITY" "${dist}/${file}"
done

for file in "${FILES[@]}"; do
  codesign --verify --strict --verbose=2 "${dist}/${file}"
  details="$(codesign --display --verbose=4 "${dist}/${file}" 2>&1)"
  echo "$details"
  for required in "Identifier=${IDENTIFIER}" "Authority=${IDENTITY}" "TeamIdentifier=${TEAM_ID}"; do
    if ! grep -qxF "$required" <<< "$details"; then
      echo "::error::${file} is not signed as expected: missing ${required}"
      exit 1
    fi
  done
  if ! grep -q '^Timestamp=' <<< "$details" || ! grep -q '^CodeDirectory .*flags=.*(.*runtime.*)' <<< "$details"; then
    echo "::error::${file} lacks a secure timestamp or the hardened runtime"
    exit 1
  fi
done

# One submission for both files. A bare binary cannot carry the notarization
# ticket (no stapling), so macOS asks Apple online when the file is first run.
mkdir "${work}/notarize"
for file in "${FILES[@]}"; do
  cp "${dist}/${file}" "${work}/notarize/"
done
ditto -c -k "${work}/notarize" "${work}/archestra-macos.zip"
submit_status=0
xcrun notarytool submit "${work}/archestra-macos.zip" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$TEAM_ID" \
  --wait --timeout 20m --output-format json > "${work}/notarization.json" || submit_status=$?
cat "${work}/notarization.json"
echo
# The exit status alone does not say Apple accepted the files: only the
# status "Accepted" does.
read -r submission status < <(python3 -c '
import json, sys
try:
    answer = json.load(open(sys.argv[1]))
except ValueError:
    answer = {}
print(answer.get("id") or "-", answer.get("status") or "-")
' "${work}/notarization.json")
if [[ "$status" != "Accepted" ]]; then
  echo "::error::Notarization did not succeed (notarytool exit ${submit_status}, status ${status})"
  if [[ "$submission" != "-" ]]; then
    xcrun notarytool log "$submission" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$TEAM_ID" || true
  fi
  exit 1
fi
echo "Signed and notarized: ${FILES[*]} (submission ${submission})"
