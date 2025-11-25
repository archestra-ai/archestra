#!/bin/bash

# This script is used to upload sourcemaps to Sentry on CI
# If the following environment variables are not set, the script skips sourcemaps upload
# - ARCHESTRA_VERSION
# - SENTRY_AUTH_TOKEN
#
# https://docs.sentry.io/platforms/javascript/guides/fastify/sourcemaps/uploading/cli/#manual-setup

if [ -z "${ARCHESTRA_VERSION:-}" ] || [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "ARCHESTRA_VERSION and SENTRY_AUTH_TOKEN are not set, skipping Sentry sourcemaps upload"
  exit 0
fi

sentry-cli sourcemaps inject --org archestra --project archestra-platform-backend ./dist
sentry-cli sourcemaps upload --version=${ARCHESTRA_VERSION} --org archestra --project archestra-platform-backend ./dist
