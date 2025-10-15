# Archestra Platform Benchmarks

Performance benchmarking tools for measuring Archestra Platform overhead using GCP VMs and Apache Bench.

## Local Testing

To test benchmarks locally against your development environment:

1. **Enable benchmark mock mode** in `platform/.env`:
   ```bash
   BENCHMARK_MOCK_MODE=true
   ```

2. **Create benchmark configuration** at `platform/benchmarks/benchmark-config.env`:
   ```bash
   export ARCHESTRA_API_URL=http://127.0.0.1:9000
   ```

3. **Run the benchmark**:
   ```bash
   cd platform/benchmarks
   bash ./run-benchmark.sh
   ```

**Note**: Make sure your local platform is running (via `tilt up` or `pnpm dev`) before running benchmarks.

## Quick Start

### 1. Prerequisites

```bash
# Install gcloud CLI
# https://cloud.google.com/sdk/docs/install

# Authenticate
gcloud auth login

```

### 2. Setup

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your GCP_PROJECT_ID, GCP_ZONE, GCP_MACHINE_TYPE

# Create VMs
bash ./setup-gcp-benchmark.sh
```

This creates:
- `archestra-platform-vm`: Runs Archestra Platform with mock mode enabled
- `loadtest-vm`: Runs Apache Bench for load testing
- Firewall rule allowing port 9000 between VMs

### 3. Run Benchmarks

```bash
# SSH into load test VM (replace zone with your configured zone)
gcloud compute ssh loadtest-vm --zone=us-central1-a

# On the VM, clone the repository
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform/benchmarks

# Copy .env configuration
cp .env.example .env
# Edit .env with NUM_REQUESTS and CONCURRENCY if needed

# Copy benchmark-config.env from your local machine to the VM
# From your local machine (in another terminal):
# gcloud compute scp benchmark-config.env loadtest-vm:~/archestra/platform/benchmarks/ --zone=us-central1-a

# Or manually create it with the Archestra VM internal IP:
# echo "export ARCHESTRA_API_URL=http://<archestra-vm-internal-ip>:9000" > benchmark-config.env

# Run benchmarks
bash ./run-benchmark.sh
```

### 4. View Results

```bash
# Results are in the results/ directory
cat results/summary_<timestamp>.md
```

### 5. Cleanup

```bash
# Delete all resources
bash ./cleanup-gcp-benchmark.sh
```

## Configuration

Edit `.env`:

- `GCP_PROJECT_ID`: Your GCP project ID
- `GCP_ZONE`: GCP zone (e.g., `us-central1-a`)
- `GCP_MACHINE_TYPE`: VM type (e.g., `n2-standard-4`)
- `NUM_REQUESTS`: Total requests per test (default: 1000)
- `CONCURRENCY`: Concurrent requests (default: 10)

## Mock Mode

The platform runs with `BENCHMARK_MOCK_MODE=true` to return immediate responses without real OpenAI API calls. This isolates pure platform overhead from network latency.

## Test Scenarios

- **simple_chat**: Basic chat completion
- **chat_with_tools**: Chat with tool definitions

## Metrics

Each test measures:
- Throughput (req/s)
- Mean Latency (ms)
- P50/P95/P99 Latency (ms)
- Failed Requests
