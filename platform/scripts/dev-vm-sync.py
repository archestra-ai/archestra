#!/usr/bin/env python3
"""Edit on the Mac, run in the dev VM (see platform/dev/vm/README.md).

Mutagen keeps a one-way copy of this checkout in the VM: every file the
repo's .gitignore files don't ignore, plus platform/.env. Nothing the VM writes comes back, and what it changes in the
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
      Only code, migrations and dependency files in platform/ and the files
      codegen writes come back, never from platform/scripts/, platform/dev/ or
      a folder starting with a dot: change anything else on the Mac.

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
# What `pull` takes back from the VM; everything else stays out.
CODE = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".css", ".sql")
MIGRATIONS = "platform/backend/src/database/migrations/"
DEPENDENCY_FILES = {"package.json", "pnpm-lock.yaml", "cargo.toml", "cargo.lock"}
# The Mac runs scripts from these (dev-vm-sync.py, dev-vm.sh, the Lima config).
MAC_RUNS = ("platform/scripts/", "platform/dev/")
# What `pnpm codegen` writes besides code; CI checks these are up to date. A
# file, or a folder (ends with /) and the ending of the files in it.
GENERATED = (
    ("docs/openapi.json", ""),
    ("docs/pages/reference/permissions.md", ""),
    ("docs/pages/reference/archestra-mcp-server/", ".md"),
    ("platform/backend/src/skills/", ".generated.md"),
    ("platform/backend/src/archestra-mcp-server/search-texts.generated.json", ""),
    ("platform/dev/grafana/dashboards/", ".json"),
)
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


def vm_settings():
    """The settings the stack needs in the VM, on top of .env.example."""
    gateway = ssh("/usr/local/sbin/archestra-kind-backend-bridge gateway").decode().strip()
    if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", gateway):
        die("no kind network in the VM: dev-vm.sh create")
    return {
        # The Mac reaches the VM's frontend and API on these forwarded ports
        # (archestra-dev.yaml), and auth trusts only the origin in
        # ARCHESTRA_FRONTEND_URL.
        "ARCHESTRA_FRONTEND_URL": "http://localhost:13000",
        "ARCHESTRA_API_BASE_URL": "http://localhost:19000",
        # Tilt builds the OpenAPPA addon only with ARCHESTRA_BETA=true; without
        # it the backend's /ready stays 503 and the login page says it can't
        # reach the server.
        "ARCHESTRA_BETA": "true",
        # Agent Runtime pods reach the backend through the bridge (setup-vm.sh).
        # Setting the URL is also what turns Agent Runtime on in Tilt for kind.
        "ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL": "http://%s:9000" % gateway,
        # No spare Agent Runtime pod: a spare holds its full size (8 GiB for
        # tier M) while idle, and Tilt's default with Agent Runtime on is 1.
        "ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE": "0",
    }


def write_env():
    """Writes platform/.env from .env.example and the VM's settings, unless
    there is one."""
    env = os.path.join(TOP, "platform", ".env")
    if os.path.islink(env):
        print("Note: platform/.env is a link, which is not copied. Replace it with a file to give the VM its settings.")
    if os.path.lexists(env):
        return
    settings = vm_settings()
    with open(env + ".example") as f:
        kept = [line for line in f if line.split("=")[0] not in settings]
    with open(env, "w") as f:
        f.write("".join(kept) + "".join("%s=%s\n" % item for item in settings.items()))
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
        # Mutagen uses your own ssh: `dev-vm.sh create` adds the VM to ~/.ssh/config.
        run(["mutagen", "sync", "create", "--name", NAME, "-c", f.name, TOP, "%s:%s" % (HOST, VM_DIR)])
    mutagen("flush", NAME)
    print("Syncing %s -> %s:~/%s. Next, from platform/: dev-vm-sync.py run, then pnpm install and tilt up." % (TOP, VM, VM_DIR))


def is_plain(path):
    parts = path.split("/")
    return not any(part in ("", ".", "..") for part in parts) and not re.search(r"[\x00-\x1f]", path)


def is_allowed(path):
    """Code, migrations and dependency files in platform/, outside the folders
    the Mac runs scripts from, and the files codegen writes. Never a folder or
    file starting with a dot (git hooks, agent and editor settings)."""
    if not path.isascii():
        return False
    path = path.lower()  # a Mac disk ignores case: Platform/Scripts is platform/scripts there
    parts = path.split("/")
    if any(p.startswith(".") for p in parts):
        return False
    for place, ending in GENERATED:
        if path == place or (place.endswith("/") and path.startswith(place) and path.endswith(ending)):
            return True
    if parts[0] != "platform" or path.startswith(MAC_RUNS):
        return False
    return path.startswith(MIGRATIONS) or path.endswith(CODE) or parts[-1] in DEPENDENCY_FILES


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
        refused = [p for p in changed + deleted if not is_allowed(p)]
        changed = [p for p in changed if is_allowed(p)]
        deleted = [p for p in deleted if is_allowed(p)]

        copied = copy_from_vm(changed)
        for path in deleted:
            target = os.path.join(TOP, path)
            if os.path.isfile(target) or os.path.islink(target):
                os.remove(target)
    finally:
        mutagen("resume", NAME)
        mutagen("flush", NAME)  # undoes whatever was not taken

    for title, paths in (("Copied to the Mac", copied), ("Deleted on the Mac", deleted),
                         ("Left out, pull takes only code, migrations, dependency files and codegen output (change these on the Mac)", refused),
                         ("Left out, git ignores these", ignored),
                         ("Left out, not a plain path or not a regular file", odd + sorted(set(changed) - set(copied)))):
        if paths:
            print("\n%s:" % title)
            for path in paths:
                print("  " + path)
    if not (copied or deleted or refused or ignored or odd):
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
            # Before creating anything: a symlinked folder that leads out of the checkout.
            if os.path.realpath(folder) != top and not os.path.realpath(folder).startswith(top + os.sep):
                continue
            os.makedirs(folder, exist_ok=True)
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
