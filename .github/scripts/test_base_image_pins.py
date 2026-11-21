"""Keep release-image bases pinned where Dependabot can bump them, on every supported line."""

import importlib.util
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_image_policy", ROOT / ".github/scripts/release-image-policy.py")
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
DOCKERFILES = sorted({image["dockerfile"].removeprefix("./")
                      for image in POLICY.candidate_matrix(ROOT)["include"]})
FROM = re.compile(r"^FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)(?:\s+AS\s+(?P<stage>\S+))?\s*$", re.I | re.M)
# Dependabot reads only literal FROM lines; it needs a version tag to propose
# bumps and a digest to keep builds reproducible.
PINNED = re.compile(r"[a-z0-9./-]+:[0-9][\w.-]*@sha256:[0-9a-f]{64}")


class BaseImagePinTest(unittest.TestCase):
    def test_every_release_image_base_is_a_versioned_digest_on_its_from_line(self):
        for dockerfile in DOCKERFILES:
            text = (ROOT / dockerfile).read_text()
            stages = set()
            for line in FROM.finditer(text):
                # A stage chosen by a build argument (FROM base-${FLAVOR})
                # resolves to an earlier stage by its default.
                image = expand_global_args(line["image"], text)
                with self.subTest(dockerfile=dockerfile, image=image):
                    if image not in stages:
                        self.assertRegex(image, PINNED)
                if line["stage"]:
                    stages.add(line["stage"])

    def test_dependabot_bumps_those_bases_on_main_and_every_supported_line(self):
        entries = docker_entries()
        lines = json.loads((ROOT / ".github/backport-targets.json").read_text())["branches"]
        directories = sorted({str(Path(dockerfile).parent) for dockerfile in DOCKERFILES})
        by_target = {}
        for entry in entries:
            by_target.setdefault(entry["target"] or "main", []).append(entry)
        self.assertEqual(sorted(by_target), sorted(["main", *lines]))
        for target, target_entries in by_target.items():
            with self.subTest(target=target):
                covered = [directory for entry in target_entries for directory in entry["directories"]]
                self.assertEqual(sorted(covered), directories)
                for entry in target_entries:
                    self.assertIn("interval: daily", entry["body"])
        # Release-line entries copy main's (dependabot.yml has no includes).
        for target_entries in by_target.values():
            self.assertEqual(sorted(entry["body"] for entry in target_entries),
                             sorted(entry["body"] for entry in by_target["main"]))

    def test_dependabot_leaves_the_sandbox_uv_base_to_sandbox_core(self):
        # check:sandbox-base requires the sandbox's uv base to equal sandbox-core's
        # DEFAULT_BASE_IMAGE, which Dependabot cannot bump alongside it.
        for entry in docker_entries():
            if "platform/docker_images/sandbox_base" in entry["directories"]:
                with self.subTest(target=entry["target"] or "main"):
                    self.assertEqual(entry["directories"], ["platform/docker_images/sandbox_base"])
                    self.assertRegex(entry["body"], r'(?m)^      - dependency-name: "\*uv"\n(?!        update-types:)')

def expand_global_args(image, dockerfile):
    """Substitutes the defaults of the ARGs declared before the first FROM."""
    preamble = dockerfile.split("\nFROM ", 1)[0]
    defaults = dict(re.findall(r"(?m)^ARG\s+(\w+)=(\S+)\s*$", preamble))
    return re.sub(r"\$\{(\w+)\}", lambda match: defaults.get(match[1], match[0]), image)


def docker_entries():
    text = (ROOT / ".github/dependabot.yml").read_text()
    entries = []
    for chunk in re.split(r"(?m)^  - package-ecosystem: ", text)[1:]:
        ecosystem, _, rest = chunk.partition("\n")
        if ecosystem.strip() != "docker":
            continue
        # Comments (including the next entry's leading one) are not configuration.
        rest = "".join(line + "\n" for line in rest.splitlines()
                       if line.strip() and not line.lstrip().startswith("#"))
        target = re.search(r"(?m)^    target-branch: (\S+)$", rest)
        body = re.sub(r"(?m)^    target-branch: \S+\n", "", rest)
        directories = re.search(r"(?m)^    directories:\n((?:      - \S+\n)+)", body)
        entries.append({"target": target and target[1], "body": body,
                        "directories": re.findall(r"- (\S+)", directories[1]) if directories else []})
    return entries


if __name__ == "__main__":
    unittest.main()
