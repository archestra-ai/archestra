#!/usr/bin/env bash
set -euo pipefail

# Diagnostic branch only: preserve the original test command and then inspect
# process teardown under gdb. No environment, memory dump, or debugger locals
# are exported; the database contains only this job's synthetic test data.
mkdir -p "$DIAGNOSTIC_DIRECTORY"
cd archestra-rs/openappa-rs
suite_status=0
pnpm test > "$DIAGNOSTIC_DIRECTORY/native-suite.log" 2>&1 || suite_status=$?
echo "Original native suite exit status: $suite_status"

# Inspect ownership errors before allocator shutdown notices corruption. Jitless
# keeps V8-generated machine code out of the memory checker; assertions remain.
for iteration in $(seq 1 5); do
  timeout 150s valgrind --error-exitcode=99 --exit-on-first-error=yes \
    --undef-value-errors=no --leak-check=no --trace-children=yes --num-callers=32 \
    --log-file="$DIAGNOSTIC_DIRECTORY/valgrind-$iteration-%p.log" \
    node --jitless --test peer.test.cjs \
    > "$DIAGNOSTIC_DIRECTORY/valgrind-test-$iteration.log" 2>&1 || {
      echo "Memory checker or peer process failed on iteration $iteration"
      exit 1
    }
  echo "Memory checker iteration $iteration completed"
done

for iteration in $(seq 1 100); do
  timeout 30s node --test peer.test.cjs \
    > "$DIAGNOSTIC_DIRECTORY/uninstrumented-peer-$iteration.log" 2>&1 || {
      echo "Uninstrumented peer process failed on iteration $iteration"
      exit 1
    }
done

for iteration in $(seq 1 100); do
  log="$DIAGNOSTIC_DIRECTORY/peer-$iteration.log"
  timeout 30s gdb --quiet --batch \
    -ex 'set pagination off' \
    -ex 'set print frame-arguments none' \
    -ex 'set follow-fork-mode child' \
    -ex 'set detach-on-fork on' \
    -ex run \
    -ex 'thread apply all bt 32' \
    --args node --test peer.test.cjs > "$log" 2>&1 || {
      echo "Debugger or peer process failed on iteration $iteration"
      tail -80 "$log"
      exit 1
    }
  if grep -Eq 'received signal|double free|corruption|exited with code|fail [1-9]' "$log"; then
    echo "Native failure captured on iteration $iteration"
    tail -120 "$log"
    exit 1
  fi
  echo "Peer teardown iteration $iteration completed"
done
exit "$suite_status"
