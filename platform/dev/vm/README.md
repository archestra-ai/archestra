# Dev VM (prototype)

Runs the whole Archestra dev stack (Tilt, backend, frontend, kind, PostgreSQL,
MCP server pods) in a Lima VM, so code from npm, cargo and container images
never runs on your Mac. You keep editing a normal checkout on the Mac, with
your own editor and agent. It is a trial next to the normal Mac setup, which
is not changed.

```
 Mac                                   Lima VM (Ubuntu, own disk)
 ───────────────────────               ─────────────────────────────────
 browser  localhost:13000  ──────────▶ :3000  frontend (next dev)  ┐ first
          localhost:19000  ──────────▶ :9000  backend              │ checkout's
          localhost:20350  ──────────▶ :10350 Tilt UI              ┘ stack
          localhost:13001… ──────────▶ :13001… next checkouts' stacks, same ports
 checkout ── Mutagen, one way ───────▶ ~/sync/<folder> (no .git)
          ◀── pull: code only ───────
                                       docker ─ kind "archestra"
 ~/.aws ~/.ssh ~/.kube  ✗ not visible     postgres, MCP pods, sandbox
 Mac 127.0.0.1 services ✗ blocked by Lima (hostLoopback: false)
```

## Setup

```sh
brew install lima mutagen-io/mutagen/mutagen
platform/scripts/dev-vm.sh create       # the VM, its tools, the kind cluster, ~/.ssh/config
echo 'export ARCHESTRA_DEV_MODE=2' >> ~/.zshenv   # tells git hooks and agents you use the VM
cd platform
echo 'I work in the dev VM with the one-way Mutagen sync. Use the archestra-dev-vm skill.' >> CLAUDE_LOCAL.md
scripts/dev-vm-sync.py start            # sync this checkout into the VM
scripts/dev-vm-sync.py tilt             # start the stack (Tilt installs dependencies); prints its URLs
```

Open http://localhost:13000 (admin@example.com / password). The first start
takes about 8 minutes: the pnpm store is empty, and prebuilt napi
addons exist only for linux x64, so on Apple Silicon every Rust addon compiles
from source.

## Commands

All from the Mac. `dev-vm.sh` and `dev-vm-sync.py` are in `platform/scripts/`;
run `dev-vm-sync.py` from inside the checkout.

The VM:

```sh
dev-vm.sh create                           # create or update the VM: tools, kind cluster, ~/.ssh/config
dev-vm.sh start                            # start a stopped VM
dev-vm.sh stop                             # stop it and free its memory; disk, caches and cluster stay
dev-vm.sh status                           # is it running
dev-vm.sh delete                           # delete the VM with its disk
ssh lima-archestra-dev                     # a shell in the VM itself: docker, systemctl, logs
```

The checkout in it:

```sh
dev-vm-sync.py start                       # sync this checkout into the VM; prints its app and Tilt URLs
dev-vm-sync.py run                         # a shell in the VM copy, in the folder you are in
dev-vm-sync.py run 'pnpm test'             # one command there
dev-vm-sync.py pull 'pnpm db:generate'     # a command that writes source files: bring them back
dev-vm-sync.py tilt                        # start this checkout's Tilt in the VM; prints its URLs
dev-vm-sync.py tilt stop                   # stop it; its pods and database stay
dev-vm-sync.py status                      # every synced checkout: URLs, Tilt running or not
dev-vm-sync.py prune                       # remove the stacks of checkouts that no longer exist
```

Checks:

```sh
.agents/skills/archestra-dev-vm/check.sh   # the VM can't see your files, keys or localhost; this checkout is synced
```

It checks, and prints a fix for each failure:

- no Mac folders are shared into the VM, and your SSH agent isn't passed in;
- the VM can't reach services on your Mac's `localhost`;
- `ssh lima-archestra-dev` works, and this checkout is synced;
- the VM holds no git, GitHub, Docker, SSH, AWS or gcloud credentials.

## Vertex AI

The VM can't use your gcloud login, and service account keys are blocked
org-wide. `scripts/dev-vm-sync.py vertex` (on the Mac, signed in as
@archestra.ai) puts a one-hour token of the `dev-vm-vertex` service account
in the VM and sends a new one every 45 minutes. That account can call Vertex
AI models and nothing else. A stand-in metadata server in the VM
(`gcp-metadata-server.py`) hands the token to Application Default
Credentials, so the backend needs no key file:

1. `scripts/dev-vm-sync.py vertex`
2. Add `GCE_METADATA_HOST=127.0.0.1:8970` to `platform/.env`, next to your
   `ARCHESTRA_*_VERTEX_AI_*` settings.
3. `scripts/dev-vm-sync.py run 'tilt trigger pnpm-dev-backend'`

`vertex status` shows what is running; `vertex stop` ends it and deletes the
VM's token.

## Daily use

- Edit on the Mac, commit on the Mac. Don't run `pnpm` or `cargo` there.
- Before a commit, run `pnpm lint` and `pnpm type-check` with `run`: the
  pre-commit check is skipped in this setup.
- For each new worktree, run `dev-vm-sync.py start` in it. It gets its own
  stack: its own ports, database and logins, next to the others.
- After a Node or Rust version bump in the repo, run `dev-vm.sh create` again.

## How it works

### The VM

Made by `dev-vm.sh create` from `archestra-dev.yaml` and `setup-vm.sh`.

- Ubuntu, on its own disk. No Mac folders, no SSH agent, no credentials.
- It can't reach your Mac's `localhost`. Lima enforces this on the Mac side,
  so even root in the VM can't undo it.
- Only the app, API and Tilt ports come out (see Several stacks at once).
  None of them clash with a stack on the Mac.
- Tools: Node at CI's version, Rust at `rust-toolchain.toml`'s, plus kind,
  kubectl, helm and Tilt. Every download is pinned and checksummed.
- Docker runs inside the VM, and kind runs on it.
- Agent Runtime pods in kind call the backend through a service in the VM,
  `archestra-kind-backend-bridge`. A backend listens only on the VM's
  `127.0.0.1` (port 9000, or 19001 to 19004), which pods can't reach; the
  service forwards the kind network's address on those ports
  (`172.18.0.1:9000` and so on, the Agent Runtime URL in `.env`) to it. On
  the Mac setup, Docker Desktop's `host.docker.internal` does this.
- `create` is safe to run again, also while Tilt runs: it skips what is done.
- Default size: 10 CPUs, 24 GiB memory, 100 GiB disk. To change it, set
  `ARCHESTRA_DEV_VM_CPUS`, `ARCHESTRA_DEV_VM_MEMORY` or `ARCHESTRA_DEV_VM_DISK`
  before the first `create`. A VM made with other ports or size gets the new
  ones only by `dev-vm.sh delete` and `create`.

### The sync

Started by `dev-vm-sync.py start`, done by [Mutagen](https://mutagen.io).

- Copies the checkout to `~/sync/<folder name>` in the VM, in under a second.
- Copies every file your `.gitignore` files don't ignore, new files too, plus
  `platform/.env`.
- One way only: the VM copy always matches the Mac. If something in the VM
  changes a copied file, the sync puts it back.
- `node_modules` and build output exist only in the VM.
- The copy has no `.git`: git stays on the Mac. That's why Tilt's
  `husky-hooks` resource is red in the VM.

### Settings (`platform/.env`)

- If the checkout has none, `start` writes it: `.env.example` plus this
  checkout's ports, `ARCHESTRA_BETA=true`, the Agent Runtime URL and no warm
  Agent Runtime pod.
- After that it's your file. Edit it on the Mac; the VM gets it, with
  anything you add, keys too.
- A `.env` that is a link isn't copied.

### Several stacks at once

Each synced checkout runs its own stack, as `scripts/dev-stack.sh` does on
the Mac. Up to 5 at once. Two idle stacks use about 5 GiB of the VM's 24.

| Stack | App | API | Tilt |
|---|---|---|---|
| first | 13000 | 19000 | 20350 |
| next ones | 13001 to 13004 | 19001 to 19004 | 20351 to 20354 |

- `start` gives a new checkout the first free stack: it looks at the other
  synced checkouts' `.env` on the Mac.
- It writes that stack's settings into the new `.env`, the same keys
  `dev-stack.sh` writes: ports, a Kubernetes namespace named after the folder
  (its own database, MCP servers and Agent Runtime pods) and its own login
  cookies, so logging in to one doesn't log you out of another.
- A stack after the first uses the same port numbers in the VM and on the Mac.
- `run` points `tilt` at the checkout's own Tilt (`TILT_PORT`).
- An existing `.env` is never changed. Don't copy one between checkouts:
  their stacks would share ports.
- Each checkout's Tilt runs in a tmux session in the VM (`tilt-<folder>`),
  started and stopped by `dev-vm-sync.py tilt` and `tilt stop`. Starting it
  twice does nothing.
- A stack stays until you stop it, as a Tilt on the Mac does. After you
  remove a worktree, `dev-vm-sync.py prune` removes its stack: Tilt, sync,
  VM copy and namespace, its database included. It also removes VM copies,
  `tilt-*` tmux sessions and `archestra-dev-*` namespaces that belong to no
  sync, never the first stack's `archestra-dev`. `status` lists them first.

### Bringing files back (`pull`)

Some commands write source files you need to commit: `pnpm lint:fix`,
`pnpm db:generate`, `pnpm codegen`, `pnpm add`, `cargo fmt`, `cargo update`,
or building a Rust addon (`pnpm --dir archestra-rs/<name> build:dev`), which
regenerates its TypeScript files. Run with
`run`, their changes stay in the VM and the sync undoes them. `pull` is for
those: it pauses the sync, runs the command, and copies back the files it
changed. It takes only:

- code in `platform/`: `.ts .tsx .js .jsx .mjs .cjs .rs .css .sql`, which
  covers Rust sources and the addons' generated `index.d.ts` and `index.cjs`
- migrations: `platform/backend/src/database/migrations/`
- dependency files: `package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`
- what `pnpm codegen` writes: `docs/openapi.json`, generated docs and skill
  copies, Grafana dashboards (the `GENERATED` list in `dev-vm-sync.py`)

It never takes:

- anything in `platform/scripts/` or `platform/dev/`: your Mac runs scripts
  from there
- anything in a folder or file starting with a dot: git hooks, agent and
  editor settings

Everything else is listed as left out, for example `rust-toolchain.toml`
or `deny.toml`: change those on the Mac. Build output, such as the compiled `.node`
addons and `target/`, never comes back: git ignores it, and it is built for
Linux anyway. It writes only plain files, never
through a link, and deletes only files git tracks. Review with `git diff`.
Don't edit on the Mac while a `pull` runs.

### `ARCHESTRA_DEV_MODE=2`

The one switch for this setup.

- Without it, the git hooks behave as on the Mac setup: a new worktree runs
  `pnpm install` on the Mac, and each commit runs a check that needs
  `node_modules`. With it, the hooks skip both.
- Agents read it too (`platform/AGENTS.md`) and switch to the
  `archestra-dev-vm` skill.
- It goes in `~/.zshenv` because zsh reads that file for every shell,
  including the ones git hooks and agents run in. `~/.zshrc` is read only by
  terminal windows.
- A git app that doesn't start from your shell still sees it unset.

### The `archestra` CLI for the Mac

- `create` copies the macOS SDK from your Command Line Tools into the VM
  (`xcode-select --install`, about 300 MB).
- With it, Tilt also builds the `archestra` program for the Mac, so the
  install command on the Connect page works on your Mac.
