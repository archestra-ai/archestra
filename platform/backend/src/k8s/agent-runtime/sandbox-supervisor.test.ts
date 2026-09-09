import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSandboxSupervisorScript } from "./sandbox-supervisor";

// This exercises real tmux, process exit and Pod replacement semantics. Enable
// explicitly where Docker and a maintained runtime image are available.
describe.skipIf(!process.env.ARCHESTRA_TEST_SANDBOX_IMAGE)(
  "sandbox supervisor",
  () => {
    it("records terminal input and detachment without treating daemon output as activity", () => {
      const result = runInContainer(`
python3 - <<'PY'
import os, pty, subprocess, time
pid, terminal = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("tmux", ["tmux", "attach", "-t", "agent"])
def activity():
    try:
        return int(open("/var/run/archestra/development-activity").read())
    except (FileNotFoundError, ValueError):
        return 0
def until(check):
    for _ in range(50):
        if check(): return
        time.sleep(.1)
    raise AssertionError("development activity was not recorded")
until(lambda: activity() > 0)
initial = activity()
subprocess.run(["tmux", "respawn-pane", "-k", "-t", "agent", "while :; do echo daemon-output; sleep 1; done"], check=True)
time.sleep(2)
assert activity() == initial, "daemon output refreshed idle retention"
os.write(terminal, b"hello")
until(lambda: activity() > initial)
typed = activity()
time.sleep(1.1)
os.write(terminal, bytes([2]) + b"d")
until(lambda: activity() > typed)
os.waitpid(pid, 0)
os.close(terminal)
PY
echo VERIFIED
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("VERIFIED");
    }, 30_000);

    it("stops a turn without removing saved work and accepts a follow-up", () => {
      const result = runInContainer(`
mkdir -p /var/run/archestra/turns
printf 'printf first > /var/run/archestra/result; touch /var/run/archestra/ready; sleep 60; touch /var/run/archestra/unwanted\\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/ready
touch /var/run/archestra/turns/1.cancel
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
      const result = runInContainer(`
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
! grep -q first-output /var/run/archestra/turns/2.log
! grep -q second-output /var/run/archestra/turns/1.log
kill -0 "$supervisor"
echo VERIFIED
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("VERIFIED");
    }, 30_000);

    it("fails an interrupted request without replaying its side effects", () => {
      const result = runInContainer(`
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
  },
);

function runInContainer(assertions: string) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network=none",
      "--entrypoint=/bin/sh",
      process.env.ARCHESTRA_TEST_SANDBOX_IMAGE ?? "",
      "-s",
    ],
    {
      encoding: "utf8",
      timeout: 25_000,
      input: `set -eu
cat > /tmp/supervisor.sh <<'SUPERVISOR'
${buildSandboxSupervisorScript()}
SUPERVISOR
/bin/sh /tmp/supervisor.sh &
supervisor=$!
trap 'kill "$supervisor" 2>/dev/null || true' EXIT
wait_for() {
  attempt=0
  while [ ! -f "$1" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || exit 99
    sleep 0.1
  done
}
wait_for_absent() {
  attempt=0
  while [ -f "$1" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || exit 99
    sleep 0.1
  done
}
set -x
${assertions}
`,
    },
  );
}
