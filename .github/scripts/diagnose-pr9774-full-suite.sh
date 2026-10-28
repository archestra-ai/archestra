#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$DIAGNOSTIC_DIRECTORY"
node_include=$(node -p 'require("node:path").resolve(process.execPath, "../../include/node")')
cc -Wall -Wextra -Werror -shared -fPIC -g \
  -I "$node_include" \
  ../.github/scripts/native-abort-backtrace.c \
  -o "$DIAGNOSTIC_DIRECTORY/native-abort-backtrace.node"
setup_script="$(pwd)/../.github/scripts/native-abort-setup.cjs"
allocator_library=$(gcc -print-file-name=libasan.so)
test -f "$allocator_library"

# The migrated base database is pristine when this script begins. Every repeat
# gets its own clone, so stable fixture identities cannot affect later runs.
export PGHOST=localhost PGUSER=archestra PGPASSWORD=archestra_ci_password
createdb --template=archestra_openappa_test pr9774_template
cd archestra-rs/openappa-rs
cp index.linux-x64-gnu.node "$DIAGNOSTIC_DIRECTORY/original-openappa.node"
for iteration in $(seq 1 10); do
  database="pr9774_repeat_$iteration"
  createdb --template=pr9774_template "$database"
  log="$DIAGNOSTIC_DIRECTORY/full-suite-$iteration.log"
  status=0
  ARCHESTRA_OPENAPPA_TEST_DATABASE_URL="postgresql://archestra:archestra_ci_password@localhost:5432/$database" \
    ARCHESTRA_NATIVE_ABORT_TRACE_ADDON="$DIAGNOSTIC_DIRECTORY/native-abort-backtrace.node" \
    NODE_OPTIONS="--require=$setup_script" \
    LD_PRELOAD="$allocator_library" \
    ASAN_OPTIONS='detect_leaks=0:abort_on_error=1:fast_unwind_on_malloc=0' \
    timeout 90s pnpm test > "$log" 2>&1 || status=$?
  dropdb --force "$database"
  echo "Fresh-database native suite $iteration: exit $status"
  if [ "$status" -ne 0 ]; then
    tail -160 "$log"
    exit "$status"
  fi
done
