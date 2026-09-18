import { describe, expect, it } from "vitest";
import { runInContainer, sandboxImage } from "@/test/agent-runtime/docker";
import { buildSandboxSupervisorScript } from "./sandbox-supervisor";

// This exercises real tmux, process exit and Pod replacement semantics. Enable
// explicitly where Docker and a maintained runtime image are available.
describe.skipIf(!sandboxImage)("sandbox supervisor", () => {
  it("keeps the same CLI and terminal contents interactive after completing a turn", () => {
    const result = runWithSupervisor(`
mkdir -p /var/run/archestra/turns
cat > /tmp/interactive.py <<'PYTHON'
import os
from pathlib import Path
Path('/tmp/original-pid').write_text(str(os.getpid()))
print('First answer', flush=True)
Path('/tmp/answer').write_text('First answer')
Path('/tmp/done').touch()
message = input()
print('Follow-up: ' + message, flush=True)
Path('/tmp/followup-pid').write_text(str(os.getpid()))
input()
PYTHON
printf 'archestra-tui-run /tmp/done /tmp/answer python3 /tmp/interactive.py\\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 0
test "$(/var/run/archestra/runtime retained)" = '1'
/var/run/archestra/runtime capture | grep -q 'First answer'
/var/run/archestra/runtime submit 'hello again'
wait_for /tmp/followup-pid
test "$(cat /tmp/original-pid)" = "$(cat /tmp/followup-pid)"
/var/run/archestra/runtime capture | grep -q 'Follow-up: hello again'
printf 'echo next-turn\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
assert_fails 1 kill -0 "$(cat /tmp/original-pid)" 2>/dev/null
test "$(/var/run/archestra/runtime retained)" = ''
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("records terminal input and detachment without treating daemon output as activity", () => {
    const result = runWithSupervisor(`
python3 /tmp/runtime-fixtures/supervisor-activity.py
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("stops a turn without removing saved work and accepts a follow-up", () => {
    const result = runWithSupervisor(`
mkdir -p /var/run/archestra/turns
printf 'printf first > /var/run/archestra/result; touch /var/run/archestra/ready; sleep 60; touch /var/run/archestra/unwanted\\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/ready
/var/run/archestra/runtime cancel 1
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 130
test "$(cat /var/run/archestra/result)" = first
test ! -f /var/run/archestra/unwanted
printf 'printf second >> /var/run/archestra/result\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
test "$(cat /var/run/archestra/result)" = firstsecond
touch /var/run/archestra/turns/3.cancel
printf 'touch /var/run/archestra/unwanted\\n' > /var/run/archestra/turns/3.request
wait_for /var/run/archestra/turns/3.exit
test "$(cat /var/run/archestra/turns/3.exit)" = 130
test ! -f /var/run/archestra/unwanted
kill -0 "$supervisor"
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("retains the workspace after completion and accepts a second turn", () => {
    const result = runWithSupervisor(`
mkdir -p /var/run/archestra/turns
printf 'printf first > /var/run/archestra/result; echo first-output\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 0
wait_for_absent /var/run/archestra/turns/1.request
kill -0 "$supervisor"
printf 'printf second >> /var/run/archestra/result; echo second-output\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
test "$(cat /var/run/archestra/result)" = firstsecond
grep -q first-output /var/run/archestra/turns/1.log
grep -q second-output /var/run/archestra/turns/2.log
assert_fails 1 grep -q first-output /var/run/archestra/turns/2.log
assert_fails 1 grep -q second-output /var/run/archestra/turns/1.log
kill -0 "$supervisor"
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("fails an interrupted request without replaying its side effects", () => {
    const result = runWithSupervisor(`
mkdir -p /var/run/archestra/turns
touch /var/run/archestra/turns/1.started
printf 'touch /var/run/archestra/replayed\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 75
test ! -f /var/run/archestra/replayed
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);
});

function runWithSupervisor(assertions: string) {
  return runInContainer(
    `cat > /tmp/supervisor.sh <<'SUPERVISOR'
${buildSandboxSupervisorScript()}
SUPERVISOR
/bin/sh /tmp/supervisor.sh &
supervisor=$!
trap 'kill "$supervisor" 2>/dev/null || true' EXIT
attempt=0
until /var/run/archestra/runtime ready 2>/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 100 ] || exit 99; sleep 0.1
done
${assertions}`,
    { mountImageHelpers: true },
  );
}
