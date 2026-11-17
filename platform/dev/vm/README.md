# Dev VM (prototype)

Runs the whole Archestra dev stack (Tilt, backend, frontend, kind, PostgreSQL,
MCP server pods) inside a Lima VM. The Mac only runs Lima and your editor.

Why: `pnpm install`, `cargo build`, MCP server images and privileged pods all
run code from the internet. On the Mac that code runs as you and can read
`~/.aws`, `~/.config/gcloud`, `~/.ssh`, `~/.kube`. In the VM there is nothing
to steal: no host folders, no SSH agent, no cloud credentials.

```
 Mac                                   Lima VM (Ubuntu, own disk)
 ───────────────────────               ─────────────────────────────────
 browser  localhost:13000  ──────────▶ :3000  frontend (next dev)
          localhost:19000  ──────────▶ :9000  backend
          localhost:20350  ──────────▶ :10350 Tilt UI
 VS Code / Cursor ── Remote-SSH ─────▶ ~/archestra (git clone)
                                       docker ─ kind "archestra"
 ~/.aws ~/.ssh ~/.kube  ✗ not visible     postgres, MCP pods, sandbox
 Mac 127.0.0.1 services ✗ blocked by Lima (hostLoopback: false)
```

## Setup

```sh
brew install lima
platform/scripts/dev-vm.sh create     # VM + Node, pnpm, rustup, docker, kind, kubectl, helm, tilt
platform/scripts/dev-vm.sh clone      # public https clone into the VM
platform/scripts/dev-vm.sh cluster    # kind cluster "archestra"
platform/scripts/dev-vm.sh tilt       # tilt up; first run ~8 min (empty pnpm store, Rust addons compile from scratch)
```

Open http://localhost:13000 (admin@example.com / password).

Resources: 6 CPUs, 12 GiB, 100 GiB disk by default; set
`ARCHESTRA_DEV_VM_CPUS`, `ARCHESTRA_DEV_VM_MEMORY`, `ARCHESTRA_DEV_VM_DISK`
before `create`.

## Editing

`dev-vm.sh ssh-config` prints an `Include` for `~/.ssh/config`. Then use
Remote-SSH in VS Code or Cursor, host `lima-archestra-dev`, folder
`~/archestra/platform`. Files live on the VM's disk, so hot reload works as on
the Mac. Also set these in the editor's user settings. They turn off SSH agent
forwarding and the editor's Git sign-in prompts; whether they cover every way
the editor hands Git credentials to a remote is not verified yet:

```json
"remote.SSH.enableAgentForwarding": false,
"git.terminalAuthentication": false
```

## Getting code in and out

The VM never pushes to GitHub. Commit in the VM, push from the Mac:

```sh
platform/scripts/dev-vm.sh ssh-config   # lines for the top of ~/.ssh/config (once)
platform/scripts/dev-vm.sh remote       # "vm" remote in the Mac repo you're in (once)
git fetch vm
git log -p origin/main..vm/<branch>     # review: code in the VM is untrusted
git push origin vm/<branch>:<branch>
```

`dev-vm.sh push <branch>` goes the other way: it copies a Mac branch into the
VM's repo.

## Worktrees

Use one VM for every checkout. `dev-vm.sh worktree <name> [base]` adds
`~/worktrees/<name>` in the VM. All checkouts share the VM's pnpm store and
Rust build folder, so only the VM's first `tilt up` is slow. One Tilt at a
time: `dev-vm.sh tilt <name>` after stopping the other.

## Agent skill

`.agents/skills/archestra-dev-vm` tells coding agents how to work through the
VM. Its `check.sh` checks the setup from the Mac (VM isolation, ssh, the `vm`
remote, no credentials in the VM).

## What it protects and what it doesn't

Protects:

- Host folders: Lima mounts none (`mounts: []`); `/Users` doesn't exist in the VM.
- SSH agent: not forwarded.
- Mac localhost: Lima normally maps `host.lima.internal` (`192.168.5.2`) to
  the Mac's `127.0.0.1`. `networkOpts.hostLoopback: false` turns that off. Lima
  enforces it on the Mac, so root in the VM can't undo it.
- Privileged pods (Dagger engine, privileged Agent Runtime) escape into the VM,
  not the Mac.

Doesn't protect:

- The internet: the VM can reach anything, so stolen *VM* secrets (provider
  API keys you put in `.env`) can still leave.
- The Mac's LAN is reachable from the VM, including Mac services that listen
  on all interfaces (not only `127.0.0.1`).
- Remote-SSH trusts the VM: code there talks to the editor. Keep the agent and
  Git credential forwarding off, and keep `ForwardAgent yes` out of
  `Host *` in your `~/.ssh/config`.

## Not done in this prototype

- Agent Runtime (needs `ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL` pointing at
  the backend from inside kind).
- `ARCHESTRA_CODE_RUNTIME_ENABLED`, MinIO, observability stack.
- Prebuilt napi addons exist only for linux x64, so on Apple Silicon every
  addon compiles from source on the first `tilt up`.
