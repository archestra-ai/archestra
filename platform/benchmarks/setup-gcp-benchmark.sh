#!/bin/bash

# GCP Benchmark Environment Setup Script
# Creates two VMs: one for Archestra Platform, one for Apache Bench load testing

set -e

# Load environment variables
if [ -f .env ]; then
    set -a
    source .env
    set +a
else
    echo "❌ Error: .env file not found"
    echo "Please copy .env.example to .env and configure your settings"
    exit 1
fi

# Check required environment variables
if [ -z "$GCP_PROJECT_ID" ]; then
    echo "❌ Error: GCP_PROJECT_ID is not set in .env"
    exit 1
fi

if [ -z "$GCP_ZONE" ]; then
    echo "❌ Error: GCP_ZONE is not set in .env"
    exit 1
fi

if [ -z "$GCP_MACHINE_TYPE" ]; then
    echo "❌ Error: GCP_MACHINE_TYPE is not set in .env"
    exit 1
fi

# Configuration
PROJECT_ID="$GCP_PROJECT_ID"
ZONE="$GCP_ZONE"
MACHINE_TYPE="$GCP_MACHINE_TYPE"
ARCHESTRA_VM_NAME="archestra-platform-vm"
LOADTEST_VM_NAME="loadtest-vm"

# VM Image
IMAGE_FAMILY="ubuntu-2204-lts"
IMAGE_PROJECT="ubuntu-os-cloud"

echo "=========================================="
echo "GCP Benchmark Environment Setup"
echo "=========================================="
echo "Project: $PROJECT_ID"
echo "Zone: $ZONE"
echo "Machine Type: $MACHINE_TYPE"
echo "=========================================="

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: gcloud CLI is not installed"
    echo "Please install it from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Set the project
echo "📋 Setting GCP project..."
gcloud config set project "$PROJECT_ID"

# Create firewall rule to allow port 9000 between VMs
echo "🔥 Creating firewall rule for port 9000..."
gcloud compute firewall-rules create archestra-benchmark-allow-9000 \
    --allow=tcp:9000 \
    --source-ranges=10.128.0.0/9 \
    --target-tags=archestra-benchmark-platform \
    --direction=INGRESS \
    2>/dev/null || echo "  Firewall rule already exists"

echo "✅ Firewall rule configured"

# Create Archestra VM
echo "🚀 Creating Archestra Platform VM..."

# Startup script for Archestra VM
ARCHESTRA_STARTUP_SCRIPT='#!/bin/bash
set -e

echo "Installing Docker..."
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io

echo "Preparing benchmark fixtures..."
git clone --depth 1 https://github.com/archestra-ai/archestra.git /opt/archestra
docker network create archestra-benchmark >/dev/null 2>&1 || true

echo "Starting WireMock..."
docker run -d \
  --name wiremock \
  --network archestra-benchmark \
  -p 9092:8080 \
  -v /opt/archestra/platform/helm/e2e-tests/mappings:/home/wiremock/mappings \
  wiremock/wiremock:3.13.1

echo "Starting Archestra Platform..."
docker run -d \
  --name archestra \
  --network archestra-benchmark \
  -p 9000:9000 \
  -p 3000:3000 \
  -e ARCHESTRA_OPENAI_BASE_URL=http://wiremock:8080/openai/v1 \
  archestra/platform:latest

echo "✅ Archestra Platform is running with WireMock upstream"
echo "API: http://$(hostname -I | awk "{print \$1}"):9000"
'

gcloud compute instances create "$ARCHESTRA_VM_NAME" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size=50GB \
    --boot-disk-type=pd-standard \
    --metadata=startup-script="$ARCHESTRA_STARTUP_SCRIPT" \
    --tags=archestra-benchmark-platform \
    2>/dev/null || echo "  VM already exists"

echo "✅ Archestra VM created"

# Create Load Test VM
echo "🔨 Creating Load Test VM..."

# Startup script for Load Test VM
LOADTEST_STARTUP_SCRIPT='#!/bin/bash
set -e

echo "Installing Apache Bench..."
apt-get update
apt-get install -y apache2-utils curl jq

echo "✅ Apache Bench installed"
'

gcloud compute instances create "$LOADTEST_VM_NAME" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size=20GB \
    --boot-disk-type=pd-standard \
    --metadata=startup-script="$LOADTEST_STARTUP_SCRIPT" \
    --tags=archestra-benchmark-loadtest \
    2>/dev/null || echo "  VM already exists"

echo "✅ Load Test VM created"

# Wait for VMs to be ready
echo "⏳ Waiting for VMs to be ready..."
sleep 30

# Get VM IPs
ARCHESTRA_INTERNAL_IP=$(gcloud compute instances describe "$ARCHESTRA_VM_NAME" \
    --zone="$ZONE" \
    --format='get(networkInterfaces[0].networkIP)')

LOADTEST_INTERNAL_IP=$(gcloud compute instances describe "$LOADTEST_VM_NAME" \
    --zone="$ZONE" \
    --format='get(networkInterfaces[0].networkIP)')

echo ""
echo "=========================================="
echo "✅ Benchmark Environment Ready!"
echo "=========================================="
echo ""
echo "📊 Archestra Platform VM:"
echo "  Name: $ARCHESTRA_VM_NAME"
echo "  Internal IP: $ARCHESTRA_INTERNAL_IP"
echo "  API Endpoint: http://$ARCHESTRA_INTERNAL_IP:9000"
echo ""
echo "🔨 Load Test VM:"
echo "  Name: $LOADTEST_VM_NAME"
echo "  Internal IP: $LOADTEST_INTERNAL_IP"
echo ""
echo "To connect:"
echo "  Archestra VM: gcloud compute ssh $ARCHESTRA_VM_NAME --zone=$ZONE"
echo "  Load Test VM: gcloud compute ssh $LOADTEST_VM_NAME --zone=$ZONE"
echo ""
echo "To check Archestra status:"
echo "  gcloud compute ssh $ARCHESTRA_VM_NAME --zone=$ZONE --command='docker logs archestra'"
echo ""
echo "To cleanup:"
echo "  ./cleanup-gcp-benchmark.sh"
echo "=========================================="

# Save configuration
cat > benchmark-config.env <<EOF
export GCP_PROJECT_ID=$PROJECT_ID
export GCP_ZONE=$ZONE
export ARCHESTRA_VM_NAME=$ARCHESTRA_VM_NAME
export LOADTEST_VM_NAME=$LOADTEST_VM_NAME
export ARCHESTRA_INTERNAL_IP=$ARCHESTRA_INTERNAL_IP
export LOADTEST_INTERNAL_IP=$LOADTEST_INTERNAL_IP
export ARCHESTRA_API_URL=http://$ARCHESTRA_INTERNAL_IP:9000
export ARCHESTRA_BENCHMARK_API_KEY=benchmark-openai-tools
EOF

echo "✅ Configuration saved to benchmark-config.env"
