#!/usr/bin/env bash
# GitHub-hosted Ubuntu runners fetch every apt suite through the mirror list in
# /etc/apt/apt-mirrors.txt, and every entry in it is an ubuntu.com host. When
# those names stop resolving, apt spends minutes timing out on each entry and
# then exits 100. Before an apt install, point the list at a mirror outside
# that DNS zone if the primary mirror does not resolve. Ubuntu's archive key
# still verifies the signed indexes, so the mirror cannot alter packages.
# With healthy DNS, or on runners without the list, nothing changes.
set -euo pipefail

mirror_list="${APT_MIRROR_LIST:-/etc/apt/apt-mirrors.txt}"
probe_host="${APT_MIRROR_PROBE_HOST:-azure.archive.ubuntu.com}"
fallback_mirror="${APT_FALLBACK_MIRROR:-https://mirrors.edge.kernel.org/ubuntu/}"

if [[ ! -f "$mirror_list" ]]; then
  exit 0
fi
if timeout 15 getent hosts "$probe_host" >/dev/null; then
  exit 0
fi

echo "::warning::${probe_host} does not resolve; apt will use ${fallback_mirror}"
entry="$(printf '%s\tpriority:1' "$fallback_mirror")"
if [[ -w "$mirror_list" ]]; then
  printf '%s\n' "$entry" >"$mirror_list"
else
  printf '%s\n' "$entry" | sudo tee "$mirror_list" >/dev/null
fi
