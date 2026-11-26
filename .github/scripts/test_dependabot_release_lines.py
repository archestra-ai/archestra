"""Every supported release line gets Dependabot updates for what it ships, and
moving to a new line moves all of them (set-release-line.py). A line cut from
main gets its own entries before its X.Y.0 makes it the supported line."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
# Main-only: ai-labs ships nothing, and workflows on a release line run from
# main's pinned actions where it matters (release-please, publish).
MAIN_ONLY = {("cargo", "ai-labs")}


class DependabotReleaseLineTest(unittest.TestCase):
    def test_each_release_line_gets_patch_updates_for_every_shipped_dependency(self):
        lines = json.loads((ROOT / ".github/backport-targets.json").read_text())["branches"]
        entries = parse((ROOT / ".github/dependabot.yml").read_text())
        shipped = {(entry["ecosystem"], directory) for entry in entries if entry["target"] is None
                   for directory in entry["directories"] if entry["ecosystem"] != "github-actions"} - MAIN_ONLY
        targets = {entry["target"] for entry in entries if entry["target"]}
        assert_release_targets(self, targets, lines)
        for line in sorted(targets):
            line_entries = [entry for entry in entries if entry["target"] == line]
            covered = {(entry["ecosystem"], directory) for entry in line_entries for directory in entry["directories"]}
            with self.subTest(line=line):
                self.assertEqual(covered, shipped)
            for entry in line_entries:
                if entry["ecosystem"] == "docker":
                    continue  # test_base_image_pins.py: the same rules as main's.
                with self.subTest(line=line, ecosystem=entry["ecosystem"]):
                    # Fixes, not features: no minor or major versions.
                    self.assertRegex(entry["body"], r'(?m)^      - dependency-name: "\*"\n        update-types:\n'
                                                    r'          - version-update:semver-major\n'
                                                    r'          - version-update:semver-minor$')

    def test_moving_the_release_line_moves_backports_and_every_dependabot_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github/scripts").mkdir(parents=True)
            for name in (".github/backport-targets.json", ".github/dependabot.yml", ".github/scripts/set-release-line.py"):
                shutil.copy(ROOT / name, root / name)
            spec = importlib.util.spec_from_file_location("set_release_line", root / ".github/scripts/set-release-line.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.main(["set-release-line.py", "release/9.8"])
            self.assertEqual(json.loads((root / ".github/backport-targets.json").read_text()), {"branches": ["release/9.8"]})
            moved = parse((root / ".github/dependabot.yml").read_text())
            before = parse((ROOT / ".github/dependabot.yml").read_text())
            self.assertEqual({entry["target"] for entry in moved if entry["target"]}, {"release/9.8"})
            self.assertEqual(len(moved), len(before))
            with self.assertRaises(SystemExit):
                module.main(["set-release-line.py", "release/1.5; rm -rf /"])

    def test_a_cut_line_gets_its_own_entries_and_then_replaces_the_old_ones(self):
        module = load(ROOT / ".github/scripts/set-release-line.py")
        text = (ROOT / ".github/dependabot.yml").read_text()
        [line] = json.loads((ROOT / ".github/backport-targets.json").read_text())["branches"]
        added = module.add_line(text, line, "release/9.8")
        before, after = parse(text), parse(added)
        old = [entry for entry in before if entry["target"] == line]
        self.assertEqual([entry for entry in after if entry["target"] == line], old)
        self.assertEqual(
            [entry["body"] for entry in after if entry["target"] == "release/9.8"],
            [entry["body"].replace(f"target-branch: {line}", "target-branch: release/9.8") for entry in old],
        )
        with self.assertRaises(ValueError):
            module.add_line(added, line, "release/9.8")
        # Moving keeps the copies and drops the old line's entries: the same file
        # as moving without them.
        self.assertEqual(module.move(added, "release/9.8"), module.move(text, "release/9.8"))
        # Moving to a third line would leave duplicate entries.
        with self.assertRaises(ValueError):
            module.move(added, "release/9.9")


def assert_release_targets(test, targets, lines):
    """Dependabot's release targets are the supported lines and, from a stable
    cut until its X.Y.0 moves the line, at most one newer line."""
    test.assertLessEqual(set(lines), set(targets))
    extra = set(targets) - set(lines)
    test.assertLessEqual(len(extra), 1, f"more than one line awaiting its X.Y.0: {sorted(extra)}")
    for branch in extra:
        test.assertTrue(all(version(branch) > version(line) for line in lines), f"{branch} is not newer than {lines}")


def version(branch):
    return tuple(int(part) for part in branch.removeprefix("release/").split("."))


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse(text):
    """Each update entry's ecosystem, target branch, directories and body,
    without comments (dependabot.yml has no includes to resolve)."""
    entries = []
    for chunk in re.split(r"(?m)^  - package-ecosystem: ", text)[1:]:
        ecosystem, _, rest = chunk.partition("\n")
        rest = "".join(line + "\n" for line in rest.splitlines()
                       if line.strip() and not line.lstrip().startswith("#"))
        target = re.search(r"(?m)^    target-branch: (\S+)$", rest)
        single = re.search(r"(?m)^    directory: (\S+)$", rest)
        several = re.search(r"(?m)^    directories:\n((?:      - \S+\n)+)", rest)
        directories = [single[1]] if single else re.findall(r"- (\S+)", several[1]) if several else []
        entries.append({"ecosystem": ecosystem.strip(), "target": target and target[1],
                        "directories": directories, "body": rest})
    return entries


if __name__ == "__main__":
    unittest.main()
