"""Keep release-image bases pinned where Dependabot can bump them.

main's .github/dependabot.yml proposes the bumps for this line; this branch's
copy is not read, so only the pins are checked here.
"""

import importlib.util
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
            stages = set()
            for line in FROM.finditer((ROOT / dockerfile).read_text()):
                image = line["image"]
                with self.subTest(dockerfile=dockerfile, image=image):
                    if image not in stages:
                        self.assertRegex(image, PINNED)
                if line["stage"]:
                    stages.add(line["stage"])


if __name__ == "__main__":
    unittest.main()
