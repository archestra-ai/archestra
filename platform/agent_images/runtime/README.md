# Terminal Drivers

A terminal driver is an executable inside an Agent image. It handles terminal processes, input, output and viewers. The common runtime owns task correlation, retained-session metadata, idle/reset policy and result access. The supervisor owns managed turn ordering and completion.

## Add A Driver

Implement the executable contract below, package the executable and its dependencies, and select it in the image:

```dockerfile
COPY my-terminal-driver /usr/local/bin/my-terminal-driver
RUN chmod 755 /usr/local/bin/my-terminal-driver \
 && mkdir -p /etc/archestra \
 && printf '%s\n' /usr/local/bin/my-terminal-driver > /etc/archestra/terminal-driver
```

For a Herdr integration, that executable would contain the Herdr adapter. Its native socket handling belongs there. This refactor does not include a Herdr implementation. No backend driver registration or Kubernetes, xterm or harness edits are needed to select a conforming executable.

The selection file contains one absolute executable path, or `tmux` to select the bundled adapter. The runtime reads it as data. An invalid explicit selection fails; it does not fall back to another driver. Without the file, it discovers `archestra-runtime-driver` on `PATH`, then defaults to bundled tmux.

The selection is pinned for the workspace. Choose a new workspace to change drivers. A selected executable's contents may change with its image; protocol validation checks compatibility, not binary identity.

## Executable Contract

The first argument is the operation. Remaining values are separate command arguments, never shell fragments. `describe` must print exactly `archestra-terminal-driver-v2`. The earlier experimental v1 protocol is incompatible with these process primitives and is rejected.

| Operation | Required behavior |
| --- | --- |
| `create SCRIPT COLS ROWS` | Create the owned terminal and run the supplied shell script at the supplied geometry. |
| `replace SCRIPT` | Replace its child with the supplied shell script, preserving attached viewers and the current recording route. |
| `ready` | Return `0` when the owned terminal exists, `1` when absent, and another nonzero status when its existence cannot be determined. Startup must establish absence before activation. |
| `alive` | Return success while its child process is alive. Terminal existence alone is insufficient. |
| `inside` | Return success when the calling shell is inside this driver's terminal. |
| `attach` | Connect the caller's terminal to the existing agent. Closing one attachment leaves the agent and other viewers running. The exec PTY delivers size changes. Preserve useful final visible output when attachment ends. |
| `submit MESSAGE` | Deliver literal text and submit it once, including leading dashes and shell syntax. |
| `capture [scrollback]` | Print the current ANSI frame, optionally including history. |
| `geometry` | Print dimensions as `COLSxROWS`; fail when the owned terminal is unavailable. |
| `present-attention FLAG LABEL` | Present attention, where FLAG is `0` or `1`. The runtime owns the state being presented. |
| `start-recording LOG` | Record subsequent output to the supplied path and container stdout independently of viewers. |
| `activity` | Print Unix timestamps of human input or detach activity. Agent output must not refresh human activity. |
| `stop` | Stop only the owned terminal; repeated calls are safe. |

Success returns status zero, failure nonzero. Use `64` for invalid arguments. Unknown operations must fail. A driver may use any language supported by its image; the common runtime requires only POSIX shell. State, sockets and recordings must remain scoped to the owned runtime. The current placement model has one managed terminal per workspace.

Task IDs, cancellation files, completion outcomes, retained-task tags and idle scripts are outside this ABI. Process liveness, terminal attention and inactivity never establish task success. Harness semantic reporting remains a separate concern.

## Source Ownership

- `runtime.sh` implements common lifecycle and metadata operations.
- `select-driver.sh` is the image-side selection point.
- `drivers/tmux.sh` implements terminal mechanics.
- `legacy-tmux-state.sh` bridges old image helpers that still write tmux options directly. New drivers do not implement this bridge.

The backend embeds these shell sources and publishes the runtime bundle. Ordinary control calls use the installed bundle. Supervisor startup is the supported activation boundary for updated code; active terminals must not be rewritten underneath their viewers. Durable task results remain outside code bundles.

## Conformance

Protocol declaration alone does not prove parity. A new driver must pass the shared behavior scenarios for literal input, geometry, capture, independent attachments and process lifecycle. The supervisor suite checks recording and turn completion. Actual browser checks verify the xterm path. Driver-specific regressions belong beside their adapter; compatibility tests cover old images and selection separately.

The behavior suite is [terminal-conformance.test.ts](../../backend/src/services/agent-runtime/image-runtime/terminal-conformance.test.ts). Add an invocation with the new image and its selection setup. The scenarios exercise the common interface; [tmux.test.ts](../../backend/src/services/agent-runtime/image-runtime/tmux.test.ts) covers tmux targeting, native detach keys and repaint sequences. [bootstrap.test.ts](../../backend/src/services/agent-runtime/image-runtime/bootstrap.test.ts) covers selection, publication and old-image compatibility.

Run from `platform/` with an image built from the current sources:

```bash
ARCHESTRA_TEST_SANDBOX_IMAGE=agent-archestra:dev \
  pnpm --dir backend exec vitest run --project clean \
  src/services/agent-runtime/image-runtime/ \
  src/k8s/agent-runtime/sandbox-supervisor.test.ts
```

Set `ARCHESTRA_TEST_LEGACY_SANDBOX_IMAGE` to an older image whose installed helpers still write tmux state to include the baked-helper compatibility check. Without these image variables, the process suites skip; a passing unit-only run does not establish terminal parity.
