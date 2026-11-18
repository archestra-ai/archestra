#!/usr/bin/env bash
# Prepares the checkout in the Lima VM once the code is in ~/archestra: the
# kind cluster, the VM's settings in platform/.env, the Rust toolchain. Runs as
# the VM user in a login shell (dev-vm.sh copies it in and runs it). Safe to
# run again.
set -euo pipefail

cd ~/archestra/platform

kind get clusters 2>/dev/null | grep -qx archestra || kind create cluster --name archestra
kubectl config use-context kind-archestra >/dev/null
# The kind network exists now: start the bridge to the backend (setup-vm.sh).
sudo systemctl restart archestra-kind-backend-bridge
gateway="$(/usr/local/sbin/archestra-kind-backend-bridge gateway)"

# Worktrees in the VM link to this file (worktree-bootstrap.sh), so it is the
# one place for the VM's settings.
[ -f .env ] || cp .env.example .env
# set_env KEY VALUE: exactly one KEY= line, also when .env.example has none.
set_env() {
  sed -i "/^$1=/d" .env
  echo "$1=$2" >> .env
}
# The Mac reaches the VM's frontend and API on these forwarded ports
# (archestra-dev.yaml), and auth trusts only the origin in ARCHESTRA_FRONTEND_URL.
set_env ARCHESTRA_FRONTEND_URL http://localhost:13000
set_env ARCHESTRA_API_BASE_URL http://localhost:19000
# Tilt builds the OpenAPPA addon only with ARCHESTRA_BETA=true; without it the
# backend's /ready stays 503 and the login page says it can't reach the server.
set_env ARCHESTRA_BETA true
# Agent Runtime pods reach the backend through the bridge. Setting the URL is
# also what turns Agent Runtime on in Tilt for a kind cluster.
set_env ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL "http://$gateway:9000"
# No spare Agent Runtime pod by default: a spare holds its full size (8 GiB for
# tier M) while idle, and Tilt's default with Agent Runtime on is 1. A value
# you set yourself stays.
grep -q '^ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE=' .env || set_env ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE 0

rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
