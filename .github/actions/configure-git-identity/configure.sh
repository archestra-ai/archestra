#!/usr/bin/env bash
set -euo pipefail

# Local configuration also applies to linked worktrees. Authentication stays
# with the caller; this only associates commits with the existing CI app.
git config --local user.name 'archestra-ci[bot]'
git config --local user.email '222894074+archestra-ci[bot]@users.noreply.github.com'
