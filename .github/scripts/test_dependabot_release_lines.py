"""Every supported release line gets Dependabot updates for what it ships, and
moving to a new line moves all of them (set-release-line.py)."""
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
        self.assertEqual({entry["target"] for entry in entries if entry["target"]}, set(lines))
        for line in lines:
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
