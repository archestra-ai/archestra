#!/usr/bin/env python3
"""Edit on the Mac, run in the dev VM (prototype; see platform/dev/vm/README.md).

Mutagen keeps a one-way copy of this checkout in the VM: what git tracks plus
platform/.env. Nothing the VM writes comes back, and what it changes in the
copied files is undone, except through `pull`.

Usage, from inside the checkout:
  dev-vm-sync.py start
      Copy this checkout to ~/sync/<folder name> in the VM and keep it up to
      date. Writes platform/.env with the VM's settings if there is none.
  dev-vm-sync.py run [<command>]
      Run a command in the VM copy, in the same subfolder you are in; without
      a command, open a shell there (pnpm install, tilt up).
  dev-vm-sync.py pull '<command>'
      Like run, for a command that writes source files (pnpm db:generate,
      pnpm add, pnpm codegen, pnpm lint:fix): copies the files it changed back
      here. Review them with git diff.
      Files your Mac runs by itself (git hooks, agent and editor settings, CI)
      are never copied: change those on the Mac.

Env: ARCHESTRA_DEV_VM (VM name, default archestra-dev).
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

VM = os.environ.get("ARCHESTRA_DEV_VM", "archestra-dev")
HOST = "lima-" + VM
SSH = ["ssh", "-F", os.path.expanduser("~/.lima/%s/ssh.config" % VM), "-o", "BatchMode=yes", HOST]
# Folders and files the Mac runs or obeys by itself.
GUARDED = {
    ".git", ".husky", ".github", ".envrc", ".mcp.json", ".vscode", ".idea", ".cursor",
    ".claude", ".agents", ".codex", "AGENTS.md", "CLAUDE.md", "CLAUDE_LOCAL.md",
}
GUARDED_FOLDED = {name.casefold() for name in GUARDED}
# Never worth listing: git ignores them, and they are large.
PRUNED = ["node_modules", ".next", "target", "dist", ".git"]


def die(message):
    sys.exit("dev-vm-sync.py: " + message)


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def git(*args, data=None):
    return run(["git", "-C", TOP, *args], input=data, stdout=subprocess.PIPE).stdout


def ssh(command, data=None):
    return run(SSH + [command], input=data, stdout=subprocess.PIPE).stdout


def mutagen(*args, quiet=True):
    out = subprocess.DEVNULL if quiet else None
    sys.stdout.flush()
    return subprocess.run(["mutagen", "sync", *args], stdout=out, stderr=out).returncode


def in_vm_copy(command):
    """Runs a command line in a login shell in the VM copy, in the subfolder
    the caller is in. Returns its exit code."""
    folder = "~/%s/%s" % (VM_DIR, os.path.relpath(os.getcwd(), TOP))
    return subprocess.run(["limactl", "shell", "--workdir", "/", VM, "--", "bash", "-lc",
                           "cd %s && %s" % (folder, command)]).returncode


def nul_list(data):
    return [p for p in data.decode().split("\0") if p]


def ignore_rules():
    """Mutagen ignore rules that leave out what git ignores."""
    rules = []
    files = nul_list(git("ls-files", "-z", "--", ".gitignore", "**/.gitignore"))
    for path in sorted(files, key=lambda f: f.count("/")):  # root first; deeper files override
        base = os.path.dirname(path)
        with open(os.path.join(TOP, path)) as f:
            for line in f:
                p = line.strip()
                if not p or p.startswith("#"):
                    continue
                negated, p = p.startswith("!"), p.lstrip("!")
                anchored = "/" in p.rstrip("/")  # a slash other than a trailing one
                p = p.lstrip("/")
                if base:
                    p = "/%s/%s" % (base, p) if anchored else "/%s/**/%s" % (base, p)
                elif anchored:
                    p = "/" + p
                rules.append(("!" if negated else "") + p)
    # A worktree's .git is a file; husky generates this folder in each checkout.
    rules += ["/.git", "/platform/.husky/_/"]
    # Files git tracks although a rule ignores them, and the VM's settings.
    keep = nul_list(git("ls-files", "-z", "-ci", "--exclude-standard")) + ["platform/.env"]
    for path in keep:
        parts = path.split("/")
        for i in range(1, len(parts) + 1):  # each parent folder, then the file
            rule = "!/" + "/".join(parts[:i])
            if rule not in rules:
                rules.append(rule)
    return rules


def write_env():
    """The VM needs its own settings (forwarded ports, the Agent Runtime URL).
    `dev-vm.sh create` wrote them into the VM's first checkout: take them from
    there and add them to this checkout's .env.example."""
    env = os.path.join(TOP, "platform", ".env")
    if os.path.islink(env):
        print("Note: platform/.env is a link, which is not copied. Replace it with a file to give the VM its settings.")
    if os.path.lexists(env):
        return
    lines = ssh("cd ~/archestra/platform && grep -vxFf .env.example .env || true").decode().splitlines()
    lines = [line for line in lines if re.fullmatch(r"[A-Z0-9_]+=[\x20-\x7e]*", line)]
    names = {line.split("=")[0] for line in lines}
    with open(env + ".example") as f:
        kept = [line for line in f if line.split("=")[0] not in names]
    with open(env, "w") as f:
        f.write("".join(kept) + "\n".join(lines) + "\n")
    print("Wrote platform/.env with the VM's settings. It is copied into the VM, with anything you add to it.")


def start():
    write_env()
    if mutagen("list", NAME) == 0:
        print("Already syncing %s -> %s:~/%s" % (TOP, VM, VM_DIR))
        mutagen("list", NAME, quiet=False)
        return
    config = [
        "sync:", "  defaults:", "    mode: one-way-replica",
        "    permissions:", "      defaultFileMode: 0644", "      defaultDirectoryMode: 0755",
        "    ignore:", "      vcs: true", "      paths:",
    ] + ["        - " + json.dumps(rule) for rule in ignore_rules()]
    ssh("mkdir -p ~/sync")
    with tempfile.NamedTemporaryFile("w", suffix=".yml") as f:
        f.write("\n".join(config) + "\n")
        f.flush()
        # Mutagen uses your own ssh: it needs the lines from `dev-vm.sh ssh-config`.
        run(["mutagen", "sync", "create", "--name", NAME, "-c", f.name, TOP, "%s:%s" % (HOST, VM_DIR)])
    mutagen("flush", NAME)
    print("Syncing %s -> %s:~/%s. Next, from platform/: dev-vm-sync.py run, then pnpm install and tilt up." % (TOP, VM, VM_DIR))


def is_plain(path):
    parts = path.split("/")
    return not any(part in ("", ".", "..") for part in parts) and not re.search(r"[\x00-\x1f]", path)


def is_guarded(path):
    # A Mac disk ignores case: .Husky is .husky there.
    return any(part.casefold() in GUARDED_FOLDED for part in path.split("/"))


def pull(command):
    marker = "/tmp/dev-vm-pull-%d" % os.getpid()
    prune = " -o ".join("-name " + name for name in PRUNED)
    mutagen("flush", NAME)  # the VM has every Mac edit
    mutagen("pause", NAME)  # ...and keeps what the command writes
    try:
        # The sleep: a write in the marker's own clock tick would not count as newer.
        ssh("touch %s && sleep 0.2" % marker)
        status = in_vm_copy(command)
        changed = nul_list(ssh(
            "cd ~/%s && find . \\( %s \\) -prune -o -type f \\( -newer %s -o -cnewer %s \\) -print0; rm -f %s"
            % (VM_DIR, prune, marker, marker, marker)))
        changed = [p[2:] if p.startswith("./") else p for p in changed]
        tracked = git("ls-files", "-z")
        deleted = nul_list(ssh(
            "cd ~/%s && while IFS= read -r -d '' f; do [ -e \"$f\" ] || printf '%%s\\0' \"$f\"; done" % VM_DIR,
            data=tracked))

        # The VM is not trusted: this side decides which paths it takes.
        odd = [p for p in changed if not is_plain(p)]
        changed = [p for p in changed if is_plain(p)]
        # Only files git tracks here can be deleted: git can bring those back.
        deleted = sorted(set(deleted) & set(nul_list(tracked)))
        ignored = set()
        if changed:
            found = subprocess.run(["git", "-C", TOP, "check-ignore", "-z", "--stdin"],
                                   input="\0".join(changed).encode(), stdout=subprocess.PIPE)
            ignored = set(nul_list(found.stdout))
        ignored = sorted(ignored)
        changed = [p for p in changed if p not in ignored]
        guarded = [p for p in changed + deleted if is_guarded(p)]
        changed = [p for p in changed if p not in guarded]
        deleted = [p for p in deleted if p not in guarded]

        copied = copy_from_vm(changed)
        for path in deleted:
            target = os.path.join(TOP, path)
            if os.path.isfile(target) or os.path.islink(target):
                os.remove(target)
    finally:
        mutagen("resume", NAME)
        mutagen("flush", NAME)  # undoes whatever was not taken

    for title, paths in (("Copied to the Mac", copied), ("Deleted on the Mac", deleted),
                         ("Left out, the Mac runs these by itself (change them on the Mac)", guarded),
                         ("Left out, git ignores these", ignored),
                         ("Left out, not a plain path or not a regular file", odd + sorted(set(changed) - set(copied)))):
        if paths:
            print("\n%s:" % title)
            for path in paths:
                print("  " + path)
    if not (copied or deleted or guarded or ignored or odd):
        print("\nThe command changed no source files.")
    print("\nReview with: git status, git diff")
    sys.exit(status)


def copy_from_vm(paths):
    """Writes the VM's content of these files into the checkout. Reads the
    VM's tar stream entry by entry and never extracts it as an archive."""
    if not paths:
        return []
    wanted, copied, top = set(paths), [], os.path.realpath(TOP)
    data = ssh("cd ~/%s && tar -cf - --null -T -" % VM_DIR, data="\0".join(paths).encode())
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive:
            path = member.name[2:] if member.name.startswith("./") else member.name
            target = os.path.join(TOP, path)
            folder = os.path.dirname(target)
            if path not in wanted or not member.isreg() or os.path.islink(target):
                continue
            os.makedirs(folder, exist_ok=True)
            if os.path.realpath(folder) != top and not os.path.realpath(folder).startswith(top + os.sep):
                continue  # a symlinked folder that leads out of the checkout
            with tempfile.NamedTemporaryFile(dir=folder, delete=False) as out:
                shutil.copyfileobj(archive.extractfile(member), out)
            os.chmod(out.name, 0o755 if member.mode & 0o100 else 0o644)
            os.replace(out.name, target)
            copied.append(path)
    return copied


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] not in ("start", "run", "pull"):
        print(__doc__.strip())
        sys.exit(1 if args else 0)
    if not shutil.which("mutagen"):
        die("install Mutagen first: brew install mutagen-io/mutagen/mutagen")
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE, text=True)
    if top.returncode != 0:
        die("run this inside the checkout you want in the VM")
    TOP = top.stdout.strip()
    NAME = os.path.basename(TOP)
    if not re.fullmatch(r"[A-Za-z0-9._-]+", NAME):
        die("the checkout's folder name must be a plain name: " + NAME)
    VM_DIR = "sync/" + NAME
    if args[0] == "start":
        start()
    elif len(args) > 2 or (args[0] == "pull" and len(args) != 2):
        die("give the command as one quoted string")
    elif mutagen("list", NAME) != 0:
        die("no sync for this checkout yet: dev-vm-sync.py start")
    elif args[0] == "run":
        sys.exit(in_vm_copy(args[1] if len(args) == 2 else "exec bash -l"))
    else:
        pull(args[1])
