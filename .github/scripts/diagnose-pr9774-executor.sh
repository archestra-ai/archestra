#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$DIAGNOSTIC_DIRECTORY"
node_include=$(node -p 'require("node:path").resolve(process.execPath, "../../include/node")')
cc -Wall -Wextra -Werror -shared -fPIC -g -I "$node_include" \
  ../.github/scripts/native-abort-backtrace.c \
  -o "$DIAGNOSTIC_DIRECTORY/native-abort-backtrace.node"
setup_script="$(pwd)/../.github/scripts/native-abort-setup.cjs"
export PGHOST=localhost PGUSER=archestra PGPASSWORD=archestra_ci_password
cd archestra-rs/openappa-rs
cp index.linux-x64-gnu.node "$DIAGNOSTIC_DIRECTORY/original-openappa.node"

# The peer fixture uses random scope IDs. Isolate each executor profile's data;
# change only Tokio's documented worker count to exercise cleanup scheduling.
for workers in 1 8 32 64; do
  database="pr9774_workers_$workers"
  createdb --template=archestra_openappa_test "$database"
  for iteration in $(seq 1 100); do
    status=0
    log="$DIAGNOSTIC_DIRECTORY/workers-$workers-peer-$iteration.log"
    ARCHESTRA_OPENAPPA_TEST_DATABASE_URL="postgresql://archestra:archestra_ci_password@localhost:5432/$database" \
      ARCHESTRA_NATIVE_ABORT_TRACE_ADDON="$DIAGNOSTIC_DIRECTORY/native-abort-backtrace.node" \
      NODE_OPTIONS="--require=$setup_script" \
      TOKIO_WORKER_THREADS="$workers" MALLOC_PERTURB_=165 \
      timeout --kill-after=5s 20s node --test peer.test.cjs > "$log" 2>&1 || status=$?
    if [ "$status" -ne 0 ]; then
      echo "Executor $workers failed on iteration $iteration with exit $status"
      tail -160 "$log"
      dropdb --force "$database"
      exit "$status"
    fi
  done
  dropdb --force "$database"
  echo "Executor $workers completed 100 peer process shutdowns"
done
