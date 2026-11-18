# Dev VM (prototype)

Runs the whole Archestra dev stack (Tilt, backend, frontend, kind, PostgreSQL,
MCP server pods) inside a Lima VM. The Mac only runs Lima, your browser and
your editor. It is a trial next to the normal Mac setup, which is not changed.

```
 Mac                                   Lima VM (Ubuntu, own disk)
 ───────────────────────               ─────────────────────────────────
 browser  localhost:13000  ──────────▶ :3000  frontend (next dev)
          localhost:19000  ──────────▶ :9000  backend
          localhost:20350  ──────────▶ :10350 Tilt UI
 git repo ── push / fetch over SSH ──▶ ~/archestra (no remotes)
                                       docker ─ kind "archestra"
 ~/.aws ~/.ssh ~/.kube  ✗ not visible     postgres, MCP pods, sandbox
 Mac 127.0.0.1 services ✗ blocked by Lima (hostLoopback: false)
```

## Setup

```sh
brew install lima
platform/scripts/dev-vm.sh create   # VM, toolchain, code, kind cluster, .env
platform/scripts/dev-vm.sh shell    # a shell in the VM's platform/; then: tilt up
```

Open http://localhost:13000 (admin@example.com / password). The first
`tilt up` takes about 8 minutes: the pnpm store is empty, and prebuilt napi
addons exist only for linux x64, so on Apple Silicon every Rust addon compiles
from source.

`create` is safe to run again; it skips what is done. It pushes this repo's
`main` (or `create <ref>`) into the VM, and writes the VM's settings into
`~/archestra/platform/.env`: the forwarded frontend and API URLs,
`ARCHESTRA_BETA=true`, the Agent Runtime URL, and no warm Agent Runtime pod.

Resources: 6 CPUs, 12 GiB, 100 GiB disk by default; set
`ARCHESTRA_DEV_VM_CPUS`, `ARCHESTRA_DEV_VM_MEMORY`, `ARCHESTRA_DEV_VM_DISK`
before the first `create`. An Agent Runtime run of the default tier M asks for
4 CPUs and 8 GiB, which needs about 10 CPUs and 16 GiB for the VM.

`dev-vm.sh shell <command>` runs one command in the VM's `platform/`
(`-w <name>` for a worktree), `dev-vm.sh stop` frees the VM's memory; the
disk, caches and cluster stay.

## Getting code in and out

The VM has no GitHub credentials and its repo has no remotes. Code moves only
between the Mac and the VM, over Lima's SSH:

```sh
platform/scripts/dev-vm.sh push <branch>   # Mac -> VM, as mac/<branch>, only the new commits

platform/scripts/dev-vm.sh ssh-config      # lines for the top of ~/.ssh/config (once)
platform/scripts/dev-vm.sh remote          # "vm" remote in this repo (once)
git fetch vm                               # VM -> Mac
git log -p origin/main..vm/<branch>        # review: code in the VM is untrusted
git push origin vm/<branch>:<branch>       # GitHub, from the Mac only
```

Because GitHub only ever talks to the Mac, this also works for a private repo
and for a shallow Mac clone.

## Worktrees

Use one VM for every checkout. `dev-vm.sh worktree <name> [base]` adds
`~/worktrees/<name>` in the VM. All checkouts share the VM's `.env`, pnpm store
and Rust build folder, so only the VM's first `tilt up` is slow. One Tilt at a
time: stop the running one, then `dev-vm.sh shell -w <name>` and `tilt up`.

## Editing

With the lines from `dev-vm.sh ssh-config`, Remote-SSH in VS Code or Cursor
reaches the VM as `lima-archestra-dev`, folder `~/archestra/platform`. Note
that Remote-SSH trusts the remote: the extension's own security note says a
compromised remote could run code on your machine. Turn these off in the
editor's user settings:

```json
"remote.SSH.enableAgentForwarding": false,
"git.terminalAuthentication": false
```

## Agent skill

`.agents/skills/archestra-dev-vm` tells coding agents how to work through the
VM. Its `check.sh` checks the setup from the Mac: the VM's isolation settings,
ssh, the `vm` remote, and that the VM holds no credentials and no git remotes.

## Not tried in this prototype

- A full Agent Runtime turn with a real model (the VM has no LLM key). The run
  pod starts and reaches the backend.
- The code sandbox is off by default as on the Mac; set
  `ARCHESTRA_CODE_RUNTIME_ENABLED=true` in the VM's `.env`.
- MinIO and the observability stack.
