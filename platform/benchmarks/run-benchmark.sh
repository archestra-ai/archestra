#!/bin/bash

# Benchmark Runner Script
# Runs Apache Bench tests against Archestra Platform
# This script should be run on the Load Test VM

set -e

# Load configuration from benchmark-config.env
if [ -f benchmark-config.env ]; then
    set -a
    source benchmark-config.env
    set +a
else
    echo "❌ Error: benchmark-config.env not found"
    echo "Please copy this file from the setup machine or run setup-gcp-benchmark.sh"
    exit 1
fi

# Check required variables
if [ -z "$ARCHESTRA_API_URL" ]; then
    echo "❌ Error: ARCHESTRA_API_URL not set in benchmark-config.env"
    exit 1
fi

# Load benchmark settings from .env if present
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Check required benchmark configuration
if [ -z "$NUM_REQUESTS" ]; then
    echo "❌ Error: NUM_REQUESTS not set in .env"
    exit 1
fi

if [ -z "$CONCURRENCY" ]; then
    echo "❌ Error: CONCURRENCY not set in .env"
    exit 1
fi

# Configuration
ARCHESTRA_API_URL="$ARCHESTRA_API_URL"
OPENAI_API_KEY="sk-mock-key"  # Any value works in mock mode
NUM_REQUESTS="$NUM_REQUESTS"
CONCURRENCY="$CONCURRENCY"
RESULTS_DIR="results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=========================================="
echo "Archestra Platform Benchmark"
echo "=========================================="
echo "API URL: $ARCHESTRA_API_URL"
echo "Requests: $NUM_REQUESTS"
echo "Concurrency: $CONCURRENCY"
echo "Timestamp: $TIMESTAMP"
echo "=========================================="

# Create results directory
mkdir -p "$RESULTS_DIR"

# Function to run Apache Bench test
run_ab_test() {
    local test_name=$1
    local endpoint=$2
    local payload_file=$3
    local output_file="$RESULTS_DIR/${test_name}_${TIMESTAMP}.txt"

    echo ""
    echo "📊 Running: $test_name"
    echo "   Endpoint: $endpoint"
    echo "   Payload: $payload_file"

    # Run Apache Bench
    ab -n "$NUM_REQUESTS" \
       -c "$CONCURRENCY" \
       -p "$payload_file" \
       -T "application/json" \
       -H "Authorization: Bearer $OPENAI_API_KEY" \
       "$endpoint" > "$output_file" 2>&1

    # Parse and display results
    echo "   ✅ Complete"

    # Extract key metrics
    local requests_per_sec=$(grep "Requests per second" "$output_file" | awk '{print $4}')
    local mean_time=$(grep "Time per request" "$output_file" | grep -v concurrent | awk '{print $4}')
    local p50=$(grep " 50%" "$output_file" | awk '{print $2}')
    local p95=$(grep " 95%" "$output_file" | awk '{print $2}')
    local p99=$(grep " 99%" "$output_file" | awk '{print $2}')
    local failed=$(grep "Failed requests" "$output_file" | awk '{print $3}')

    echo "   Throughput: $requests_per_sec req/s"
    echo "   Mean Latency: ${mean_time}ms"
    echo "   P50: ${p50}ms"
    echo "   P95: ${p95}ms"
    echo "   P99: ${p99}ms"
    echo "   Failed: $failed"

    # Append to summary (markdown table row)
    echo "| $test_name | $requests_per_sec | ${mean_time} | ${p50} | ${p95} | ${p99} | $failed |" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
}

# Initialize summary file
cat > "$RESULTS_DIR/summary_${TIMESTAMP}.md" <<EOF
# Archestra Platform Benchmark Results

**Date**: $(date)
**API URL**: $ARCHESTRA_API_URL
**Total Requests**: $NUM_REQUESTS
**Concurrency**: $CONCURRENCY
**Mock Mode**: Enabled (no real OpenAI API calls)

---

## Results

| Test Scenario | Throughput (req/s) | Mean Latency (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Failed |
|---------------|-------------------|-------------------|----------|----------|----------|---------|
EOF

# Test: Chat with Tools
run_ab_test \
    "chat_with_tools" \
    "${ARCHESTRA_API_URL}/v1/openai/chat/completions" \
    "test-payloads/chat-with-tools.json"

echo "" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "---" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "## Notes" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "- All tests run with mock OpenAI responses (no network latency)" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "- Metrics show pure Archestra platform overhead" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "- Full Apache Bench output available in individual result files" >> "$RESULTS_DIR/summary_${TIMESTAMP}.md"

echo ""
echo "=========================================="
echo "✅ Benchmark Complete!"
echo "=========================================="
echo ""
echo "Results saved to: $RESULTS_DIR/"
echo "Summary: $RESULTS_DIR/summary_${TIMESTAMP}.md"
echo ""
echo "View summary:"
echo "  cat $RESULTS_DIR/summary_${TIMESTAMP}.md"
echo "=========================================="

# Display summary
cat "$RESULTS_DIR/summary_${TIMESTAMP}.md"
