#!/bin/bash

# GCP Benchmark Cleanup Script
# Deletes all resources created by setup-gcp-benchmark.sh

set -e

# Load configuration from benchmark-config.env (created by setup script)
if [ -f benchmark-config.env ]; then
    set -a
    source benchmark-config.env
    set +a
else
    echo "❌ Error: benchmark-config.env not found"
    echo "This file is created by setup-gcp-benchmark.sh"
    echo "Please run setup-gcp-benchmark.sh first, or set variables manually:"
    echo "  export GCP_PROJECT_ID=your-project-id"
    echo "  export GCP_ZONE=us-central1-a"
    exit 1
fi

# Check required variables
if [ -z "$GCP_PROJECT_ID" ]; then
    echo "❌ Error: GCP_PROJECT_ID not set in benchmark-config.env"
    exit 1
fi

if [ -z "$GCP_ZONE" ]; then
    echo "❌ Error: GCP_ZONE not set in benchmark-config.env"
    exit 1
fi

PROJECT_ID="$GCP_PROJECT_ID"
ZONE="$GCP_ZONE"
ARCHESTRA_VM_NAME="archestra-platform-vm"
LOADTEST_VM_NAME="loadtest-vm"

echo "=========================================="
echo "GCP Benchmark Cleanup"
echo "=========================================="
echo "Project: $PROJECT_ID"
echo "Zone: $ZONE"
echo "=========================================="

# Set the project
gcloud config set project "$PROJECT_ID"

# Delete VMs
echo "🗑️  Deleting VMs..."
gcloud compute instances delete "$ARCHESTRA_VM_NAME" --zone="$ZONE" --quiet 2>/dev/null || echo "  Archestra VM not found"
gcloud compute instances delete "$LOADTEST_VM_NAME" --zone="$ZONE" --quiet 2>/dev/null || echo "  Load Test VM not found"
echo "✅ VMs deleted"

# Delete firewall rule
echo "🗑️  Deleting firewall rule..."
gcloud compute firewall-rules delete archestra-benchmark-allow-9000 --quiet 2>/dev/null || echo "  Firewall rule not found"
echo "✅ Firewall rule deleted"

# Remove local configuration
if [ -f benchmark-config.env ]; then
    rm benchmark-config.env
    echo "✅ Local configuration removed"
fi

echo ""
echo "=========================================="
echo "✅ Cleanup Complete!"
echo "=========================================="
