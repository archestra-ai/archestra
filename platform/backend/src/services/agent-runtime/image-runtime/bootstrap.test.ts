import { describe, expect, it } from "vitest";
import { buildAgentRuntimeTerminalIntegrationScript } from "@/k8s/agent-runtime/manifests";
import { runInContainer, sandboxImage } from "@/test/agent-runtime/docker";
import { buildImageRuntimeInstallScript } from "./bootstrap";
import { imageRuntimeCommand } from "./control";

function installationScripts() {
  return `
cat > /tmp/ensure-runtime <<'ENSURE'
${buildImageRuntimeInstallScript()}
ENSURE
cat > /tmp/activate-runtime <<'ACTIVATE'
${buildImageRuntimeInstallScript({ activate: true })}
ACTIVATE
runtime=/var/run/archestra/runtime
`;
}

function expectSuccess(script: string) {
  const result = runInContainer(`${installationScripts()}\n${script}`, {
    user: "root",
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe.skipIf(!sandboxImage)(
  "image runtime installation and compatibility",
  () => {
    for (const [label, command] of Object.entries({
      control: imageRuntimeCommand("submit", "must not be delivered"),
      "terminal integration": [
        "/bin/sh",
        "-c",
        buildAgentRuntimeTerminalIntegrationScript(),
      ],
    })) {
      it(`stops ${label} when the installed facade rejects compatibility`, () => {
        expectSuccess(`
mkdir -p /var/run/archestra
cat > "$runtime" <<'INCOMPATIBLE'
#!/bin/sh
if [ "$1" = describe ]; then echo archestra-image-runtime-v999; else touch /tmp/unexpected-operation; fi
INCOMPATIBLE
chmod 700 "$runtime"
assert_fails 78 ${command.map((argument) => `'${argument.replace(/'/g, "'\\''")}'`).join(" ")}
test ! -e /tmp/unexpected-operation
test ! -e /var/run/archestra/attach
test ! -e /var/run/archestra/shell-init
`);
      });
    }

    it("publishes one complete bundle when ordinary callers race", () => {
      expectSuccess(`
/bin/sh /tmp/ensure-runtime & first=$!
/bin/sh /tmp/ensure-runtime & second=$!
/bin/sh /tmp/ensure-runtime & third=$!
wait "$first"; wait "$second"; wait "$third"
test "$("$runtime" describe)" = archestra-image-runtime-v1
test "$(find /var/run/archestra -maxdepth 1 -type d -name 'runtime-bundle.*' | wc -l)" -eq 1
"$runtime" initialize
"$runtime" ready
`);
    });

    it("selects an explicit image entry point ahead of the PATH hook and preserves argument boundaries", () => {
      expectSuccess(`
mkdir -p /etc/archestra
cat > "/tmp/runtime-bin/selected driver's" <<'DRIVER'
#!/bin/sh
case "$1" in
  describe) echo archestra-terminal-driver-v2 ;;
  submit) printf '%s' "$2" > /tmp/received ;;
  *) exit 42 ;;
esac
DRIVER
chmod 700 "/tmp/runtime-bin/selected driver's"
printf "  /tmp/runtime-bin/selected driver's  \\n" > /etc/archestra/terminal-driver
printf '#!/bin/sh\\nexit 99\\n' > /tmp/runtime-bin/archestra-runtime-driver
chmod 700 /tmp/runtime-bin/archestra-runtime-driver
/bin/sh /tmp/ensure-runtime
message='literal $(touch /tmp/injected); café'
"$runtime" submit "$message"
test "$(cat /tmp/received)" = "$message"
test ! -e /tmp/injected
assert_fails 42 "$runtime" capture
`);
    });

    it("rejects malformed selections and incompatible terminal protocols without falling back", () => {
      expectSuccess(`
mkdir -p /etc/archestra
for selection in '' 'relative-driver' '/tmp/nonexistent-driver' "$(printf 'tmux\\n/tmp/other')"; do
  printf '%s\\n' "$selection" > /etc/archestra/terminal-driver
  assert_fails 78 /bin/sh /tmp/ensure-runtime
  test ! -e "$runtime"
done
printf '/tmp/runtime-bin/incompatible\\n' > /etc/archestra/terminal-driver
printf '#!/bin/sh\\necho archestra-terminal-driver-v1\\n' > /tmp/runtime-bin/incompatible
chmod 700 /tmp/runtime-bin/incompatible
assert_fails 78 /bin/sh /tmp/ensure-runtime
test ! -e "$runtime"
rm /etc/archestra/terminal-driver
odd_directory="$(printf '/tmp/path\\nwith-newline')"
mkdir -p "$odd_directory"
printf '#!/bin/sh\\necho archestra-terminal-driver-v2\\n' > "$odd_directory/archestra-runtime-driver"
chmod 700 "$odd_directory/archestra-runtime-driver"
PATH="$odd_directory:$PATH" assert_fails 78 /bin/sh /tmp/ensure-runtime
test ! -e "$runtime"
test "$(find /var/run/archestra -maxdepth 1 -type d -name 'runtime-bundle.*' | wc -l)" -eq 0
`);
    });

    it("keeps live code on ensure and activates a new revision only at stopped startup with its original driver", () => {
      expectSuccess(`
/bin/sh /tmp/ensure-runtime
sed -i '3s/archestra-runtime-revision:.*/archestra-runtime-revision: previous/' "$runtime"
cp "$runtime" /tmp/previous-runtime
"$runtime" initialize
mkdir -p /etc/archestra /var/run/archestra/turns
printf '/tmp/new-image-driver\\n' > /etc/archestra/terminal-driver
printf '0\\n' > /var/run/archestra/turns/task-1.exit
/bin/sh /tmp/ensure-runtime
cmp "$runtime" /tmp/previous-runtime
assert_fails 78 /bin/sh /tmp/activate-runtime
cmp "$runtime" /tmp/previous-runtime
"$runtime" stop
/bin/sh /tmp/activate-runtime
if cmp -s "$runtime" /tmp/previous-runtime; then exit 1; fi
test "$("$runtime" read-result task-1)" = 0
"$runtime" initialize
"$runtime" ready
`);
    });

    it("leaves compatible legacy facades untouched until startup and recognizes their pinned tmux selection", () => {
      expectSuccess(`
mkdir -p /var/run/archestra
cat > "$runtime" <<'LEGACY'
#!/bin/sh
driver='/var/run/archestra/runtime-terminal'
case "$1" in describe) echo archestra-image-runtime-v1;; ready) exit 1;; *) exit 99;; esac
LEGACY
chmod 700 "$runtime"
cp "$runtime" /tmp/legacy-runtime
/bin/sh /tmp/ensure-runtime
cmp "$runtime" /tmp/legacy-runtime
/bin/sh /tmp/activate-runtime
"$runtime" initialize
"$runtime" ready
`);
    });

    it("refuses activation when terminal absence cannot be established", () => {
      expectSuccess(`
cat > /tmp/runtime-bin/archestra-runtime-driver <<'DRIVER'
#!/bin/sh
case "$1" in
  describe) echo archestra-terminal-driver-v2 ;;
  ready) exit 42 ;;
  *) touch /tmp/unexpected-operation ;;
esac
DRIVER
chmod 700 /tmp/runtime-bin/archestra-runtime-driver
/bin/sh /tmp/ensure-runtime
cp "$runtime" /tmp/previous-runtime
assert_fails 78 /bin/sh /tmp/activate-runtime
cmp "$runtime" /tmp/previous-runtime
test ! -e /tmp/unexpected-operation
`);
    });

    it("owns task metadata and durable results without sending task operations to the terminal driver", () => {
      expectSuccess(`
cat > /tmp/runtime-bin/archestra-runtime-driver <<'DRIVER'
#!/bin/sh
case "$1" in
  describe) echo archestra-terminal-driver-v2 ;;
  create|replace|present-attention) ;;
  alive) exit 0 ;;
  submit) exit 42 ;;
  *) echo "Unexpected driver operation: $1" >&2; exit 99 ;;
esac
DRIVER
chmod 700 /tmp/runtime-bin/archestra-runtime-driver
/bin/sh /tmp/ensure-runtime
"$runtime" initialize
"$runtime" retained task-1
test "$("$runtime" retained)" = task-1
"$runtime" attention 1 'Input required'
test "$("$runtime" attention)" = "$(printf '1\\nInput required')"
"$runtime" reset
test -z "$("$runtime" retained)"
test "$("$runtime" attention)" = 0
assert_fails 42 "$runtime" submit message
mkdir -p /var/run/archestra/turns
printf '75\\n' > /var/run/archestra/turns/task-1.exit
printf 'Native harness failure' > /var/run/archestra/turns/task-1.failure
printf '#!/bin/sh\\necho archestra-terminal-driver-v999\\n' > /tmp/runtime-bin/archestra-runtime-driver
/bin/sh /tmp/ensure-runtime
assert_fails 78 "$runtime" initialize
test "$("$runtime" read-result task-1)" = "$(printf '75\\nNative harness failure')"
"$runtime" cancel task-2
test "$("$runtime" read-result task-2)" = 130
assert_fails 64 "$runtime" read-result ../task-1
mkfifo /var/run/archestra/steer
cat /var/run/archestra/steer > /tmp/fifo-message & reader=$!
"$runtime" submit-fifo 'literal $(touch /tmp/injected)'
wait "$reader"
test "$(cat /tmp/fifo-message)" = 'literal $(touch /tmp/injected)'
test ! -e /tmp/injected
`);
    });
  },
);

const legacyImage = process.env.ARCHESTRA_TEST_LEGACY_SANDBOX_IMAGE;
describe.skipIf(!legacyImage)("pre-facade image helper compatibility", () => {
  it("imports completion and attention from baked helpers while keeping their completed process alive", () => {
    const result = runInContainer(
      `${installationScripts()}
# This check intentionally rejects a fixture whose helpers already use the facade.
grep -F '["tmux", "set-option"' /usr/local/bin/archestra-tui-exec
grep -F 'tmux set-option' /usr/local/bin/archestra-agent-attention
/bin/sh /tmp/ensure-runtime
mkdir -p /var/run/archestra/turns
"$runtime" initialize
cat > /tmp/retained-cli.sh <<'CLI'
printf '%s\\n' "$$" > /tmp/retained-cli.pid
archestra-agent-attention set 'Legacy input required'
printf 'Legacy final answer' > /tmp/answer
touch /tmp/completion
while IFS= read -r line; do printf '%s\\n' "$line" > /tmp/received; done
CLI
cat > /tmp/turn.sh <<'TURN'
export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX=/var/run/archestra/turns/legacy-task
export ARCHESTRA_AGENT_RUNTIME_ANSWER_FILE=/tmp/answer
exec archestra-tui-exec /tmp/completion /tmp/frame /bin/sh /tmp/retained-cli.sh
TURN
"$runtime" launch /tmp/turn.sh
wait_for /var/run/archestra/turns/legacy-task.result
test "$(cat /var/run/archestra/turns/legacy-task.result)" = 0
test "$("$runtime" retained)" = legacy-task
test "$("$runtime" attention)" = "$(printf '1\\nLegacy input required')"
kill -0 "$(cat /tmp/retained-cli.pid)"
"$runtime" submit 'after completion'
wait_for /tmp/received
test "$(cat /tmp/received)" = 'after completion'
grep -F 'Legacy final answer' /var/run/archestra/turns/legacy-task.log
"$runtime" reset
test -z "$("$runtime" retained)"
test "$("$runtime" attention)" = 0
`,
      { image: legacyImage },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
