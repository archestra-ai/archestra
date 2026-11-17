---
name: archestra-dev-vm
description: Use when working on Archestra through the dev VM (Lima VM "archestra-dev", platform/scripts/dev-vm.sh) instead of the Mac — checking the VM setup and the "vm" git remote, running Tilt, pnpm, cargo or tests in the VM, adding worktrees there, or moving commits from the VM to the Mac to push.
---

# Archestra in the dev VM

The dev VM is a trial alongside the normal Mac setup (`tilt up` on the Mac
keeps working). Everything that runs code from npm, cargo or container images
(Tilt, the backend, the frontend, `pnpm install`, Rust builds, kind) runs in
one Lima VM that has no Mac folders and no credentials. The Mac keeps the
browser, the editor, and the GitHub credentials.

```
 Mac                                        Lima VM "archestra-dev"
 browser  localhost:13000 / 19000 / 20350 ─▶ frontend :3000 / backend :9000 / Tilt :10350
 editor   Remote-SSH lima-archestra-dev ──▶ ~/archestra, ~/worktrees/<name>
 git      git fetch vm  ◀───────────────── commits made in the VM
 git push origin (only from the Mac)
```

## First: check the setup

Run from the Mac checkout the user pushes from:

```sh
.agents/skills/archestra-dev-vm/check.sh
```

It checks the VM, its isolation (no mounts, no SSH agent, Mac localhost
blocked by `networkOpts.hostLoopback: false`), that ssh knows
`lima-archestra-dev`, the `vm` git remote, and that the VM holds no Git,
GitHub, SSH or cloud credentials. Each failure prints its fix. Don't edit the
user's `~/.ssh/config` yourself: show them the lines from
`platform/scripts/dev-vm.sh ssh-config`.

## Where commands run

- Code, dependencies and the dev stack live in the VM: `~/archestra` (main
  clone) and `~/worktrees/<name>`. Run `pnpm`, `cargo`, `tilt`, `kubectl` and
  tests there, never on the Mac for VM work:
  `ssh lima-archestra-dev 'cd ~/archestra/platform && pnpm --filter @archestra/backend test'`
  (`dev-vm.sh shell [name]` for an interactive shell).
- `kubectl` in the VM talks to the kind cluster `kind-archestra`, not the
  Mac's contexts.
- The Mac's localhost is not reachable from the VM. A Mac service the VM
  needs must listen on another address; say so instead of turning
  `hostLoopback` back on.
- The Mac reaches the VM on its ports plus 10000: web UI
  `http://localhost:13000` (admin@example.com / password), API
  `http://localhost:19000`, Tilt UI `http://localhost:20350`.

## Worktrees and caches

Use one VM. `dev-vm.sh worktree <name> [base]` adds `~/worktrees/<name>` on
branch `<name>` from the main clone, copying its `.env`. All checkouts in the
VM share the pnpm store and the Rust build folder (`~/.cache/archestra-rs-target`),
so only the first `tilt up` in the VM is slow (about 8 minutes). One Tilt at a
time on the default ports: stop the running one, then `dev-vm.sh tilt <name>`.

## Moving code between the Mac and the VM

- Mac → VM: `dev-vm.sh push <branch>` copies a Mac branch into the VM's repo.
- VM → Mac → GitHub: commit in the VM, then on the Mac:

  ```sh
  git fetch vm
  git log -p origin/main..vm/<branch>   # review before pushing
  git push origin vm/<branch>:<branch>
  ```

  Code in the VM is untrusted: review the fetched diff before pushing, and
  point out changes the user didn't make (lockfiles, scripts, CI files,
  `.husky`, `package.json` scripts).
- Never put GitHub credentials, `gh auth`, SSH keys or cloud credentials in
  the VM. The VM clones over public https and never pushes.

## Setup from scratch

```sh
brew install lima
platform/scripts/dev-vm.sh create    # VM + toolchain
platform/scripts/dev-vm.sh clone     # ~/archestra from GitHub, .env for the VM
platform/scripts/dev-vm.sh cluster   # kind cluster "archestra"
platform/scripts/dev-vm.sh tilt      # first run ~8 minutes
platform/scripts/dev-vm.sh ssh-config   # lines for ~/.ssh/config
platform/scripts/dev-vm.sh remote       # "vm" remote in the Mac repo you're in
```

`dev-vm.sh stop` frees the VM's memory (about 8 GB with Tilt running); disk,
caches and the cluster stay. Details and limits: `platform/dev/vm/README.md`.
