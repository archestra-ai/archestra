import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxSupervisorScript } from "./sandbox-supervisor";

// This exercises real process groups, process exit and Pod replacement semantics. Enable
// explicitly where Docker and a maintained runtime image are available.
describe.skipIf(!process.env.ARCHESTRA_TEST_SANDBOX_IMAGE)(
  "sandbox supervisor",
  () => {
    it("runs structured agents without a TTY, keeps a separate shell, and cancels their process group", () => {
      const result = runInContainer(
        `
mkdir -p /var/run/archestra/turns
printf 'test ! -t 0; echo native-output; setsid sleep 61 & echo $! > /var/run/archestra/child; touch /var/run/archestra/ready; sleep 60; touch /var/run/archestra/unwanted\\n' > /var/run/archestra/turns/1.request
wait_for /var/run/archestra/ready
/bin/sh -c 'touch /var/run/archestra/shell-worked'
wait_for /var/run/archestra/shell-worked
touch /var/run/archestra/turns/1.cancel
wait_for /var/run/archestra/turns/1.exit
test "$(cat /var/run/archestra/turns/1.exit)" = 130
! kill -0 "$(cat /var/run/archestra/child)" 2>/dev/null
test ! -f /var/run/archestra/unwanted
grep -q native-output /var/run/archestra/turns/1.log
printf 'echo second-native-turn\\n' > /var/run/archestra/turns/2.request
wait_for /var/run/archestra/turns/2.exit
test "$(cat /var/run/archestra/turns/2.exit)" = 0
echo VERIFIED
`,
        true,
      );
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

function runInContainer(assertions: string, structured = false) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network=none",
      "-v",
      `${path.resolve("../agent_images/bin")}:/usr/local/bin:ro`,
      "--entrypoint=/usr/bin/tini",
      process.env.ARCHESTRA_TEST_SANDBOX_IMAGE ?? "",
      "-s",
      "--",
      "/bin/sh",
      "-s",
    ],
    {
      encoding: "utf8",
      timeout: 25_000,
      input: `set -eu
${structured ? 'mkdir -p /tmp/native-bin; touch /tmp/native-bin/archestra-agent-session; chmod +x /tmp/native-bin/archestra-agent-session; export PATH="/tmp/native-bin:$PATH" ARCHESTRA_AGENT_RUNTIME_INTERFACE=structured' : ""}
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
