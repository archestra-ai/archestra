import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("apt-mirror-fallback.sh")
IMAGE_MIRRORS = (
    "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
    "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
)


class AptMirrorFallbackTest(unittest.TestCase):
    def run_script(self, mirror_list: Path, probe_host: str) -> None:
        env = {
            **os.environ,
            "APT_MIRROR_LIST": str(mirror_list),
            "APT_MIRROR_PROBE_HOST": probe_host,
            "APT_FALLBACK_MIRROR": "https://mirror.example/ubuntu/",
        }
        subprocess.run(["bash", str(SCRIPT)], env=env, check=True)

    def test_keeps_image_mirrors_when_primary_resolves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mirror_list = Path(tmp, "apt-mirrors.txt")
            mirror_list.write_text(IMAGE_MIRRORS)
            self.run_script(mirror_list, "localhost")
            self.assertEqual(mirror_list.read_text(), IMAGE_MIRRORS)

    def test_switches_to_fallback_when_primary_does_not_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mirror_list = Path(tmp, "apt-mirrors.txt")
            mirror_list.write_text(IMAGE_MIRRORS)
            self.run_script(mirror_list, "mirror.invalid")
            self.assertEqual(
                mirror_list.read_text(),
                "https://mirror.example/ubuntu/\tpriority:1\n",
            )

    def test_ignores_runners_without_a_mirror_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mirror_list = Path(tmp, "apt-mirrors.txt")
            self.run_script(mirror_list, "mirror.invalid")
            self.assertFalse(mirror_list.exists())


if __name__ == "__main__":
    unittest.main()
