import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSandboxSupervisorScript } from "./sandbox-supervisor";

// This exercises the selected terminal backend, process exit and Pod
// replacement semantics. Enable explicitly where Docker and a maintained
// packaged runtime image are available. Mounting over /usr/local/bin would
// hide the image's Herdr binary and accidentally test the legacy backend.
describe.skipIf(!process.env.ARCHESTRA_TEST_SANDBOX_IMAGE)(
  "sandbox supervisor",
  () => {
    it("keeps the same CLI and terminal contents interactive after completing a turn", () => {
      const result = runInContainer(`
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
test "$(terminal_retained)" = '0:1'
terminal_capture 1 | grep -q 'First answer'
terminal_send 1 'hello again'
wait_for /tmp/followup-pid
test "$(cat /tmp/original-pid)" = "$(cat /tmp/followup-pid)"
terminal_capture 1 | grep -q 'Follow-up: hello again'
printf 'echo next-turn\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
! kill -0 "$(cat /tmp/original-pid)" 2>/dev/null
test "$(terminal_retained)" = '1:'
echo VERIFIED
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("VERIFIED");
    }, 30_000);

    it("records terminal input and detachment without treating daemon output as activity", () => {
      const result = runInContainer(`
mkdir -p /var/run/archestra/turns
printf 'while :; do echo daemon-output; sleep 1; done\\n' > /var/run/archestra/turns/activity.request
wait_for /var/run/archestra/turns/activity.running
RUNTIME_BACKEND="$backend" python3 - <<'PY'
import os, pty, subprocess, time
pid, terminal = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    if os.environ["RUNTIME_BACKEND"] == "herdr":
        os.execvp("archestra-terminal", ["archestra-terminal", "attach"])
    os.execvp("tmux", ["tmux", "attach", "-t", "agent"])
def saved_activity():
    try:
        return int(open("/var/run/archestra/development-activity").read())
    except (FileNotFoundError, ValueError):
        return 0
def activity():
    timestamps = [saved_activity()]
    if os.environ["RUNTIME_BACKEND"] == "tmux":
        # Match the manager's live-client query while the supervisor is busy.
        clients = subprocess.run(["tmux", "list-clients", "-F", "#{client_activity}"],
                                 capture_output=True, text=True, check=True)
        timestamps.extend(int(value) for value in clients.stdout.split() if value.isdigit())
    return max(timestamps)
def until(check):
    for _ in range(50):
        if check(): return
        time.sleep(.1)
    raise AssertionError("development activity was not recorded")
until(lambda: activity() > 0)
initial = activity()
time.sleep(2)
assert activity() == initial, "daemon output refreshed idle retention"
os.write(terminal, b"hello")
until(lambda: activity() > initial)
typed = activity()
time.sleep(1.1)
os.write(terminal, bytes([2]) + b"d")
until(lambda: saved_activity() > typed)
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
backend=tmux
terminal_helper=
if command -v archestra-terminal >/dev/null 2>&1 && command -v herdr >/dev/null 2>&1; then
  archestra-terminal serve >/tmp/terminal-server.log 2>&1 &
  terminal_helper=$!
  terminal_pid=$terminal_helper
  export terminal_pid
  attempt=0
  until archestra-terminal ready >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || { cat /tmp/terminal-server.log >&2; exit 98; }
    sleep 0.1
  done
  printf herdr > /var/run/archestra/terminal-backend
  backend=herdr
fi
trap 'if [ -n "$terminal_helper" ]; then kill "$terminal_helper" 2>/dev/null || true; fi; kill "$supervisor" 2>/dev/null || true' EXIT
terminal_retained() {
  if [ "$backend" = herdr ]; then archestra-terminal retained; else tmux display-message -p -t agent '#{pane_dead}:#{@archestra_retained_task}'; fi
}
terminal_capture() {
  if [ "$backend" = herdr ]; then archestra-terminal capture --task "$1"; else tmux capture-pane -p -t agent; fi
}
terminal_send() {
  if [ "$backend" = herdr ]; then printf '%s' "$2" | archestra-terminal steer --task "$1"; else tmux send-keys -t agent -l -- "$2" && sleep 1 && tmux send-keys -t agent Enter; fi
}
/bin/sh /tmp/supervisor.sh &
supervisor=$!
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
