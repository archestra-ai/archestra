#!/bin/sh
# Upload backend source maps to Sentry
#
# This script injects debug IDs and uploads source maps for better error stack traces.
# It requires the following environment variables:
#   - SENTRY_AUTH_TOKEN: Sentry authentication token (required)
#   - VERSION: Release version for Sentry (optional, defaults to "dev")
#
# Usage: ./upload-sourcemaps.sh
#
# Reference: https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/

set -e

SENTRY_ORG="archestra"
SENTRY_PROJECT="archestra-platform-backend"
VERSION="${VERSION:-dev}"

if [ -z "$SENTRY_AUTH_TOKEN" ]; then
  echo "SENTRY_AUTH_TOKEN not set, skipping backend source map upload"
  exit 0
fi

echo "Uploading backend source maps to Sentry..."
echo "  Organization: $SENTRY_ORG"
echo "  Project: $SENTRY_PROJECT"
echo "  Release: $VERSION"

# Inject debug IDs into source files and source maps
npx @sentry/cli sourcemaps inject dist

# Upload source maps to Sentry
npx @sentry/cli sourcemaps upload dist \
  --org "$SENTRY_ORG" \
  --project "$SENTRY_PROJECT" \
  --release "$VERSION"

echo "Backend source maps uploaded successfully"

