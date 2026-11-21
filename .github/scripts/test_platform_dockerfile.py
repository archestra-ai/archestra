"""The platform Dockerfile's two published images stay in step: the Kubernetes
image (unified-slim) is built on a different base than the runtime stage, so it
declares the runtime's environment again, and it has no shell to run scripts."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = (ROOT / "platform/Dockerfile").read_text()


def stage(name):
    match = re.search(rf"^FROM \S+ AS {re.escape(name)}\n(.*?)(?=^FROM |\Z)", DOCKERFILE, re.M | re.S)
    return match.group(1)


def env(text):
    return re.findall(r"^ENV (\S+?)=(.*)$", text, re.M)


class PlatformDockerfileTests(unittest.TestCase):
    def test_the_kubernetes_image_declares_the_runtime_environment(self):
        self.assertEqual(env(stage("unified-slim")), env(stage("runtime")))

    def test_the_kubernetes_image_runs_node_not_a_shell(self):
        slim = stage("unified-slim")
        self.assertIn('ENTRYPOINT ["node", "/app/entrypoint.mjs"]', slim)
        self.assertIn("USER 10001", slim)
        for instruction in re.findall(r"^(?:CMD|ENTRYPOINT|RUN|HEALTHCHECK) .*$", slim, re.M):
            self.assertNotRegex(instruction, r"\.sh\b|/bin/sh|wget|curl", instruction)
        self.assertNotRegex(slim, r"(?m)^RUN ")

    def test_both_bases_are_the_same_hardened_node_release(self):
        pins = dict((alias, ref) for ref, alias in re.findall(r"^FROM (\S+) AS (runtime|runtime-base-distroless)$", DOCKERFILE, re.M))
        release = lambda ref: re.match(r"^dhi\.io/node:([\d.]+-alpine[\d.]+)", ref).group(1)
        self.assertEqual(release(pins["runtime-base-distroless"]), release(pins["runtime"]))
        self.assertIn("-dev@sha256:", pins["runtime"])
        self.assertNotIn("-dev@", pins["runtime-base-distroless"])


if __name__ == "__main__":
    unittest.main()
