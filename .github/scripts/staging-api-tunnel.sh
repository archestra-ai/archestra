#!/usr/bin/env bash
# Reach the private staging API (https://backend.archestra.dev) from a GitHub
# runner, for sync-terraform-provider.yml.
#
# Opens the IAM-authenticated IAP tunnel to the staging VPN gateway's TLS
# forwarder, then points backend.archestra.dev at it on this runner only: an
# /etc/hosts entry and a loopback redirect from port 443 to the tunnel. TLS
# still terminates at staging with its real certificate and hostname. Needs
# gcloud with the job's Google credentials and passwordless sudo
# (GitHub-hosted runners). The same script serves archestra-ai/infra's
# Terraform CI.
set -euo pipefail

port=18443
log="${RUNNER_TEMP:?}/staging-api-tunnel.log"

gcloud compute start-iap-tunnel staging-vpn 8443 \
  --project=friendly-path-465518-r6 --zone=us-central1-a \
  --local-host-port="127.0.0.1:${port}" --quiet >"$log" 2>&1 &

for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if ! (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
  echo "::error::The IAP tunnel to the staging API did not start."
  cat "$log"
  exit 1
fi

echo "127.0.0.1 backend.archestra.dev" | sudo tee -a /etc/hosts >/dev/null
sudo iptables -t nat -A OUTPUT -o lo -p tcp -d 127.0.0.1 --dport 443 -j REDIRECT --to-ports "$port"

curl --fail --silent --show-error --max-time 20 --output /dev/null https://backend.archestra.dev/health
echo "Staging API reachable through the IAP tunnel."
