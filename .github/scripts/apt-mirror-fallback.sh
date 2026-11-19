#!/usr/bin/env bash
# GitHub-hosted Ubuntu runners fetch every apt suite through the mirror list in
# /etc/apt/apt-mirrors.txt. Its preferred Azure HTTP mirror can stall even when
# DNS resolves and the secondary HTTPS mirror serves release metadata: apt may
# still retry package indexes on Azure. Use the HTTPS mirror alone before apt
# runs, with an alternate DNS zone if archive.ubuntu.com does not resolve.
# Ubuntu's archive key still verifies the signed indexes.
set -euo pipefail

mirror_list="${APT_MIRROR_LIST:-/etc/apt/apt-mirrors.txt}"
probe_host="${APT_MIRROR_PROBE_HOST:-archive.ubuntu.com}"
primary_mirror="${APT_PRIMARY_MIRROR:-https://archive.ubuntu.com/ubuntu/}"
fallback_mirror="${APT_FALLBACK_MIRROR:-https://mirrors.edge.kernel.org/ubuntu/}"

if [[ ! -f "$mirror_list" ]]; then
  exit 0
fi
if timeout 15 getent hosts "$probe_host" >/dev/null 2>&1; then
  mirror="$primary_mirror"
else
  echo "::warning::${probe_host} does not resolve; apt will use ${fallback_mirror}"
  mirror="$fallback_mirror"
fi

entry="$(printf '%s\tpriority:1' "$mirror")"
if [[ -w "$mirror_list" ]]; then
  printf '%s\n' "$entry" >"$mirror_list"
else
  printf '%s\n' "$entry" | sudo tee "$mirror_list" >/dev/null
fi
