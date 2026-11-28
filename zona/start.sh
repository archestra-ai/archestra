#!/usr/bin/env bash
# zona's start hook: runs in the VM copy's platform/ folder at every
# `zona start` and `zona env`, right after zona built platform/.env from your
# own file and zona/env-override. Safe to run twice.
set -euo pipefail

# Keys .env.example has and the built .env lacks, so a worktree with no
# platform/.env on the Mac still gets every default. The built file wins.
tmp="$(mktemp)"
awk -F= 'NR == FNR { if ($0 !~ /^[[:space:]]*#/ && NF > 1) have[$1] = 1; next }
         $0 !~ /^[[:space:]]*#/ && NF > 1 && !($1 in have)' .env .env.example > "$tmp"
if grep -q '=' "$tmp"; then
  { echo "# zona start.sh: defaults from .env.example"; cat "$tmp"; } >> .env
fi
rm -f "$tmp"

# This worktree's bridge from the kind network to its backend.
sudo systemctl enable --now -q "archestra-kind-bridge@${ZONA_PORT_9000}.service"

# Dependencies, so the commit check and `zona run` work before Tilt does.
pnpm install --frozen-lockfile --reporter=append-only
