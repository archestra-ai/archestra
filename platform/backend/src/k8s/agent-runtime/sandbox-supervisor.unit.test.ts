import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxSupervisorScript } from "./sandbox-supervisor";
import {
  AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE,
  AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE,
  buildWorkspaceExitTrapScript,
} from "./workspace-exit";

// This exercises real tmux, process exit and Pod replacement semantics. Enable
// explicitly where Docker and a maintained runtime image are available
// (ARCHESTRA_TEST_SANDBOX_IMAGE), or on Linux with tmux installed in an
// unprivileged user namespace (ARCHESTRA_TEST_SANDBOX_NAMESPACE=1), where the
// same script runs on a private tmpfs that the full-volume cases size.
const SANDBOX_IMAGE = process.env.ARCHESTRA_TEST_SANDBOX_IMAGE;
const NAMESPACE_FLAGS = ["-Urpfm", "--mount-proc"];
const NAMESPACE =
  !SANDBOX_IMAGE &&
  process.env.ARCHESTRA_TEST_SANDBOX_NAMESPACE === "1" &&
  namespaceAvailable();
describe.skipIf(!SANDBOX_IMAGE && !NAMESPACE)("sandbox supervisor", () => {
  it("stops the Pod with the full-volume status when the agent fills the volume and exits", () => {
    // The turn's own result no longer fits: no empty result may appear, and
    // the supervisor's next write ends PID 1 through the startup's trap.
    const result = runInContainer(
      `
printf 'touch /tmp/started; ${FILL_VOLUME}; exit 0\\n' > /var/run/archestra/turns/1.request
wait_for /tmp/started
status=0
wait "$supervisor" || status=$?
test "$status" = ${AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE}
test ! -e /var/run/archestra/turns/1.result
test ! -e /var/run/archestra/turns/1.exit
test -f /var/run/archestra/turns/1.request
echo VERIFIED
`,
      { volumeKiB: 2048 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
    expect(result.stderr).toMatch(
      /agent-runtime: The workspace volume is full \(\d+ of 2 MiB used\), so the run stopped\. Ask an administrator for a larger workspace volume, then start a new run\./,
    );
  }, 30_000);

  it("stops the Pod with the full-volume status when the turn's output no longer fits", () => {
    const result = runInContainer(
      `
printf 'touch /tmp/started; ${FILL_VOLUME}; head -c 8192 /dev/zero | tr "\\\\0" a; echo; sleep 60\\n' > /var/run/archestra/turns/1.request
wait_for /tmp/started
status=0
wait "$supervisor" || status=$?
test "$status" = ${AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE}
echo VERIFIED
`,
      { volumeKiB: 2048 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
    expect(result.stderr).toContain("The workspace volume is full (");
  }, 30_000);

  it("stops the Pod with the full-volume status when no inodes are left", () => {
    const result = runInContainer(
      `
printf 'touch /tmp/started; i=0; while touch /var/run/archestra/file-$i 2>/dev/null; do i=$((i + 1)); done; exit 0\\n' > /var/run/archestra/turns/1.request
wait_for /tmp/started
status=0
wait "$supervisor" || status=$?
test "$status" = ${AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE}
echo VERIFIED
`,
      { volumeKiB: 8192, inodes: 64 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
    expect(result.stderr).toContain(
      "The workspace volume is full (no room for more files), so the run stopped.",
    );
  }, 30_000);

  it("stops at startup with the full-volume status on a full volume", () => {
    const result = runInContainer(
      `
kill "$supervisor"
wait "$supervisor" 2>/dev/null || true
rm -f /var/run/archestra/record-terminal
${FILL_VOLUME}
status=0
/bin/sh /tmp/supervisor.sh || status=$?
test "$status" = ${AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE}
echo VERIFIED
`,
      { volumeKiB: 2048 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  // Remounting the runtime directory read-only needs the namespace harness.
  it.skipIf(!NAMESPACE)(
    "stops the Pod with the unwritable-volume status on a read-only volume with space",
    () => {
      const result = runInContainer(`
printf 'touch /tmp/started; while [ ! -f /tmp/go ]; do sleep 0.1; done; echo after; sleep 60\\n' > /var/run/archestra/turns/1.request
wait_for /tmp/started
mount -o remount,ro,bind /run
touch /tmp/go
status=0
wait "$supervisor" || status=$?
test "$status" = ${AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE}
echo VERIFIED
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("VERIFIED");
      expect(result.stderr).toContain(
        "The workspace volume cannot be written although it has space, so the run stopped.",
      );
    },
    30_000,
  );

  it("keeps the exit status of a failure the volume did not cause", () => {
    const result = runInContainer(`
kill "$supervisor"
wait "$supervisor" 2>/dev/null || true
tmux new-session -d -s agent 'sleep 60'
status=0
/bin/sh /tmp/supervisor.sh 2>/dev/null || status=$?
test "$status" = 1
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("clears retained terminal ownership when recording fails after completion", () => {
    const result = runInContainer(`
cat > /var/run/archestra/turns/1.request <<'TURN'
touch /tmp/started
while [ ! -f /tmp/complete ]; do sleep 0.1; done
tmux set-option -t agent @archestra_retained_task 1
printf '0\\n' > /var/run/archestra/turns/1.result
touch /tmp/completed
sleep 60
TURN
wait_for /tmp/started
kill -STOP "$supervisor"
touch /tmp/complete
wait_for /tmp/completed
client="$(tmux list-clients -F '#{client_name}')"
tmux detach-client -t "$client"
sleep 0.2
kill -CONT "$supervisor"
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 75
test "$(tmux show-option -v -t agent @archestra_retained_task)" = ''
kill -0 "$supervisor"
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it.each([
    "disconnect",
    "parser error",
  ])("fails a recording %s without losing output or ending the workspace", (failure) => {
    const result = runInContainer(`
printf 'echo retained-output; touch /tmp/started; sleep 60\\n' > /var/run/archestra/turns/1.request
wait_for /tmp/started
${failure === "disconnect" ? 'client="$(tmux list-clients -F \'#{client_name}\')"\ntmux detach-client -t "$client"' : "printf 'not-a-tmux-command\\n' > /var/run/archestra/turns/1.recording-input"}
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 75
grep -q retained-output /var/run/archestra/turns/1.log
python3 - <<'PY'
import json
assert json.load(open('/var/run/archestra/turns/1.failure'))['code'] == 'runtime.recording_failed'
PY
kill -0 "$supervisor"
test ! -e /var/run/archestra/turns/1.recording-input
printf 'echo follow-up\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
test "$(cat /var/run/archestra/turns/2.exit)" = 0
grep -q follow-up /var/run/archestra/turns/2.log
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("bounds recording startup without launching unrecorded work", () => {
    const result = runInContainer(`
cp /var/run/archestra/record-terminal /tmp/original-recorder
printf 'while IFS= read -r event; do :; done\\n' > /var/run/archestra/record-terminal
printf 'touch /tmp/unrecorded-work\\n' > /var/run/archestra/turns/1.request
sleep 12
test -f /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 75
test ! -f /tmp/unrecorded-work
test ! -e /var/run/archestra/turns/1.recording-input
test -z "$(tmux list-clients -F '#{client_name}')"
kill -0 "$supervisor"
cp /tmp/original-recorder /var/run/archestra/record-terminal
printf 'echo follow-up\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
test "$(cat /var/run/archestra/turns/2.exit)" = 0
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("records initial and resized grids in order even when a turn is canceled", () => {
    const result = runInContainer(`
tmux set-option -t agent status off
tmux resize-window -t agent -x 80 -y 23
cat > /tmp/redraw.py <<'PYTHON'
import os, signal, time
from pathlib import Path
def redraw(*args):
    width, height = os.get_terminal_size()
    print('\\x1b[2J\\x1b[Hframe:%dx%d' % (width, height), flush=True)
    Path('/tmp/frame-%dx%d' % (width, height)).touch()
signal.signal(signal.SIGWINCH, redraw)
redraw()
while True: time.sleep(.1)
PYTHON
printf 'python3 /tmp/redraw.py\\n' > /var/run/archestra/turns/1.request
wait_for /tmp/frame-80x23
tmux resize-window -t agent -x 200 -y 57
wait_for /tmp/frame-200x57
touch /var/run/archestra/turns/1.cancel
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 130
python3 - <<'PYTHON'
from pathlib import Path
recording = Path('/var/run/archestra/turns/1.log').read_bytes()
initial = b'\\x1b]777;archestra-terminal-size=80x23\\x07'
resized = b'\\x1b]777;archestra-terminal-size=200x57\\x07'
assert recording.startswith(initial), repr(recording)
assert recording.index(initial) < recording.index(b'frame:80x23') < recording.index(resized) < recording.index(b'frame:200x57'), repr(recording)
assert not Path('/var/run/archestra/development-activity').exists(), 'recorder counted as human activity'
PYTHON
printf 'echo next-turn\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
python3 - <<'PYTHON'
from pathlib import Path
recording = Path('/var/run/archestra/turns/2.log').read_bytes()
assert recording.startswith(b'\\x1b]777;archestra-terminal-size=200x57\\x07'), repr(recording)
assert b'next-turn' in recording and b'frame:' not in recording, repr(recording)
PYTHON
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("keeps the same CLI and tmux contents interactive after completing a turn", () => {
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
test "$(tmux display-message -p -t agent '#{pane_dead}:#{@archestra_retained_task}')" = '0:1'
tmux capture-pane -p -t agent | grep -q 'First answer'
tmux send-keys -t agent 'hello again' Enter
wait_for /tmp/followup-pid
test "$(cat /tmp/original-pid)" = "$(cat /tmp/followup-pid)"
tmux capture-pane -p -t agent | grep -q 'Follow-up: hello again'
printf 'echo next-turn\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
! kill -0 "$(cat /tmp/original-pid)" 2>/dev/null
test "$(tmux show-option -v -t agent @archestra_retained_task)" = ''
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

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

  it.each([
    true,
    false,
  ])("fails an interrupted request without replaying its side effects (failure file writable: %s)", (writable) => {
    const result = runInContainer(`
mkdir -p /var/run/archestra/turns
touch /var/run/archestra/turns/1.started
${writable ? "" : 'mkdir "/var/run/archestra/turns/1.failure.tmp.$supervisor"'}
printf 'touch /var/run/archestra/replayed\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 75
${
  writable
    ? `python3 - <<'PY'
import json
failure = json.load(open('/var/run/archestra/turns/1.failure'))
assert failure['version'] == 1
assert failure['code'] == 'runtime.interrupted'
assert 'not replayed' in failure['message']
PY`
    : "test ! -f /var/run/archestra/turns/1.failure"
}
test ! -f /var/run/archestra/replayed
kill -0 "$supervisor"
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);

  it("explains a crashed pane without replaying the turn", () => {
    const result = runInContainer(`
mkdir -p /var/run/archestra/turns
printf 'touch /var/run/archestra/ready; sleep 60\\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/ready
pane_pid="$(tmux display-message -p -t agent '#{pane_pid}')"
kill -KILL "$pane_pid"
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 75
python3 - <<'PY'
import json
failure = json.load(open('/var/run/archestra/turns/1.failure'))
assert failure['version'] == 1
assert failure['code'] == 'runtime.pane_exited'
assert 'unexpectedly' in failure['message']
PY
echo VERIFIED
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VERIFIED");
  }, 30_000);
});

const IMAGE_BIN = path.resolve("../docker_images/agent/bin");

/** Fills the runtime directory's volume: large blocks, then the last pages. */
const FILL_VOLUME =
  "dd if=/dev/zero of=/var/run/archestra/fill bs=32k 2>/dev/null || true; dd if=/dev/zero of=/var/run/archestra/fill2 bs=1k 2>/dev/null || true";

/** Whether this machine can run the script in an unprivileged user namespace. */
function namespaceAvailable(): boolean {
  return (
    process.platform === "linux" &&
    spawnSync(
      "unshare",
      [
        ...NAMESPACE_FLAGS,
        "/bin/sh",
        "-c",
        "mount -t tmpfs tmpfs /run && mkdir -p /var/run/archestra && command -v tmux >/dev/null",
      ],
      { encoding: "utf8", timeout: 10_000 },
    ).status === 0
  );
}

/**
 * Runs the supervisor as a child of a shell at PID 1, then the assertions in
 * that shell. In a container the runtime directory is the image's; in a
 * namespace it is a private tmpfs of `volumeKiB` (256 MiB when not given),
 * which is also what a full-volume case uses in a container.
 */
function runInContainer(
  assertions: string,
  options: { volumeKiB?: number; inodes?: number } = {},
) {
  const volume = options.volumeKiB;
  const inodes = options.inodes ? `,nr_inodes=${options.inodes}` : "";
  const [command, args, prelude] = NAMESPACE
    ? [
        "bash",
        // The recorder appends to /proc/1/fd/1, which must be a pipe or a
        // file: the stdout spawnSync gives a child is a socket, which cannot
        // be opened that way. A pipe outside the namespace outlives its PID 1.
        [
          "-c",
          `set -o pipefail; unshare ${NAMESPACE_FLAGS.join(" ")} /bin/sh -s | cat`,
        ],
        `mount -t tmpfs tmpfs /tmp
mount -t tmpfs -o size=${volume ?? 262144}k${inodes} tmpfs /run
mkdir -p /var/run/archestra/turns
export PATH="$ARCHESTRA_TEST_IMAGE_BIN:$PATH"`,
      ]
    : [
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--network=none",
          "-v",
          `${IMAGE_BIN}:/usr/local/bin:ro`,
          ...(volume
            ? ["--tmpfs", `/var/run/archestra:size=${volume}k${inodes}`]
            : []),
          "--entrypoint=/bin/sh",
          SANDBOX_IMAGE ?? "",
          "-s",
        ],
        "",
      ];
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 25_000,
    env: { ...process.env, ARCHESTRA_TEST_IMAGE_BIN: IMAGE_BIN },
    input: `set -eu
${prelude}
cat > /tmp/supervisor.sh <<'SUPERVISOR'
set -eu
${buildWorkspaceExitTrapScript()}
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
while ! tmux has-session -t agent 2>/dev/null; do sleep 0.1; done
${assertions}
`,
  });
}
