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
    def run_script(self, mirror_list: Path, dns_resolves: bool) -> None:
        # Keep the DNS outcome deterministic on macOS and Linux.
        command_dir = mirror_list.parent / "bin"
        command_dir.mkdir()
        getent = command_dir / "getent"
        getent.write_text(f"#!/bin/sh\nexit {0 if dns_resolves else 1}\n")
        getent.chmod(0o755)
        env = {
            **os.environ,
            "PATH": f"{command_dir}:{os.environ['PATH']}",
            "APT_MIRROR_LIST": str(mirror_list),
            "APT_PRIMARY_MIRROR": "https://archive.example/ubuntu/",
            "APT_FALLBACK_MIRROR": "https://mirror.example/ubuntu/",
        }
        subprocess.run(["bash", str(SCRIPT)], env=env, check=True)

    def test_avoids_azure_http_even_when_dns_resolves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mirror_list = Path(tmp, "apt-mirrors.txt")
            mirror_list.write_text(IMAGE_MIRRORS)
            self.run_script(mirror_list, True)
            self.assertEqual(
                mirror_list.read_text(),
                "https://archive.example/ubuntu/\tpriority:1\n",
            )

    def test_switches_to_fallback_when_primary_does_not_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mirror_list = Path(tmp, "apt-mirrors.txt")
            mirror_list.write_text(IMAGE_MIRRORS)
            self.run_script(mirror_list, False)
            self.assertEqual(
                mirror_list.read_text(),
                "https://mirror.example/ubuntu/\tpriority:1\n",
            )

    def test_ignores_runners_without_a_mirror_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mirror_list = Path(tmp, "apt-mirrors.txt")
            self.run_script(mirror_list, False)
            self.assertFalse(mirror_list.exists())


if __name__ == "__main__":
    unittest.main()
