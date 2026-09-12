#!/usr/bin/env python3
"""Check Drizzle upgrade paths across release tracks without connecting to a DB.

Drizzle executes only timestamps above the source database's high-water mark.
SQL hashes identify equivalent backports even when their filenames differ.
See platform/backend/src/database/migrations/README.md for repair policy.
Explicit repair coverage is reviewed alongside the repair's database regression test.
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
from pathlib import Path

MIGRATIONS = "platform/backend/src/database/migrations"


def git(*args):
    return subprocess.check_output(["git", *args])


def read_file(ref, name):
    relative = f"{MIGRATIONS}/{name}"
    if ref == "WORKTREE":
        root = Path(git("rev-parse", "--show-toplevel").decode().strip())
        return (root / relative).read_bytes()
    return git("show", f"{ref}:{relative}")


def load_history(ref):
    entries = json.loads(read_file(ref, "meta/_journal.json"))["entries"]
    if ref == "WORKTREE":
        root = Path(git("rev-parse", "--show-toplevel").decode().strip()) / MIGRATIONS
        contents = [(root / (entry["tag"] + ".sql")).read_bytes() for entry in entries]
    else:
        # Read blobs in one Git process: migration histories contain hundreds of
        # files, and snapshots are much larger than the SQL we need here.
        requests = "".join(f"{ref}:{MIGRATIONS}/{entry['tag']}.sql\n" for entry in entries)
        output = subprocess.check_output(["git", "cat-file", "--batch"], input=requests.encode())
        stream = io.BytesIO(output)
        contents = []
        for entry in entries:
            header = stream.readline().split()
            if len(header) != 3 or header[1] != b"blob":
                raise ValueError(f"Cannot read {ref}:{entry['tag']}.sql")
            contents.append(stream.read(int(header[2])))
            if stream.read(1) != b"\n":
                raise ValueError("Invalid git cat-file response")
    return [dict(entry, hash=hashlib.sha256(content).hexdigest())
            for entry, content in zip(entries, contents)]


def load_repairs(ref):
    # Older releases predate this manifest. Only absence is allowed; malformed
    # JSON, unknown refs, and other read failures must still fail the check.
    if ref == "WORKTREE":
        root = Path(git("rev-parse", "--show-toplevel").decode().strip())
        if not (root / MIGRATIONS / "upgrade-repairs.json").exists():
            return {}
    elif not git("ls-tree", "--full-tree", "--name-only", ref, f"{MIGRATIONS}/upgrade-repairs.json").strip():
        return {}
    return json.loads(read_file(ref, "upgrade-repairs.json"))


def upgrade_errors(source, target, repairs):
    high_water = max((entry["when"] for entry in source), default=-1)
    source_hashes = {entry["hash"] for entry in source}
    target_hashes = {entry["hash"] for entry in target}
    target_by_tag = {entry["tag"]: entry for entry in target}
    covered = set()
    errors = []
    for repair_tag, replacements in repairs.items():
        repair = target_by_tag.get(repair_tag)
        if not repair:
            errors.append(f"Unknown repair migration: {repair_tag}")
            continue
        for tag, expected_hash in replacements.items():
            original = target_by_tag.get(tag)
            if not original or original["hash"] != expected_hash:
                errors.append(f"{repair_tag}: repair coverage for {tag} does not match its SQL")
            elif repair["when"] <= original["when"]:
                errors.append(f"{repair_tag}: repair must be newer than {tag}")
            elif repair["when"] > high_water or repair["hash"] in source_hashes:
                covered.add(expected_hash)

    for entry in source:
        if entry["hash"] not in target_hashes:
            errors.append(f"Source migration {entry['tag']} has no SQL-equivalent migration in target")
    for entry in target:
        applied = entry["hash"] in source_hashes
        if entry["when"] <= high_water and not applied and entry["hash"] not in covered:
            errors.append(f"Drizzle skips {entry['tag']} ({entry['when']} <= {high_water}); "
                          "add a newer idempotent repair and register its tested coverage")
        elif entry["when"] > high_water and applied:
            errors.append(f"Drizzle replays already-applied SQL in {entry['tag']}; "
                          "preserve migration timestamps when backporting")
    return errors


def check_upgrade(source_ref, target_ref):
    errors = upgrade_errors(load_history(source_ref), load_history(target_ref), load_repairs(target_ref))
    print(f"Migration upgrade: {source_ref} -> {target_ref}")
    for error in errors:
        print(f"  ERROR: {error}")
    if not errors:
        print("  All required migrations are applied or covered by an eligible repair.")
    return not errors


def release_paths(base_branch):
    if re.fullmatch(r"release/\d+\.\d+", base_branch):
        # A backport must support both upgrades within stable and a subsequent
        # move to main. Land any required forward repair on main first.
        return [(f"origin/{base_branch}", "WORKTREE"), ("WORKTREE", "origin/main")]
    if base_branch != "main":
        target = f"origin/{base_branch}"
        try:
            git("rev-parse", "--verify", "--quiet", target)
            return [(target, "WORKTREE")]
        except Exception:
            return [("origin/main", "WORKTREE")]
    refs = git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/").decode().splitlines()
    stable_refs = [ref for ref in refs if re.fullmatch(r"origin/release/\d+\.\d+", ref)]
    if not stable_refs:
        raise ValueError("No stable release refs found; fetch origin release/* before checking upgrades")
    return [("origin/main", "WORKTREE"), *[(ref, "WORKTREE") for ref in stable_refs]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-branch", help="PR base or release branch; checks all supported upgrade paths")
    parser.add_argument("--source-ref", help="Source git ref (or WORKTREE)")
    parser.add_argument("--target-ref", default="WORKTREE", help="Target git ref (default: WORKTREE)")
    args = parser.parse_args()
    if bool(args.base_branch) == bool(args.source_ref):
        parser.error("provide exactly one of --base-branch or --source-ref")
    paths = release_paths(args.base_branch) if args.base_branch else [(args.source_ref, args.target_ref)]
    results = [check_upgrade(source, target) for source, target in paths]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
