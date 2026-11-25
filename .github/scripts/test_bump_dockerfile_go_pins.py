"""bump-dockerfile-go-pins.py moves Dockerfile `go get` pins the way the
release-age rule and the release line allow, and nothing else."""
import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("bump_go_pins", ROOT / ".github/scripts/bump-dockerfile-go-pins.py")
BUMP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUMP)

NOW = datetime.datetime(2026, 11, 20, tzinfo=datetime.timezone.utc)
# module -> {version: days before NOW it was published}
RELEASES = {
    "github.com/go-jose/go-jose/v4": {"v4.1.6": 60, "v4.1.7": 21, "v4.2.0": 10, "v4.2.1-rc.1": 9, "v4.2.2": 2},
    "golang.org/x/net": {"v0.62.0": 30, "v0.63.0": 8},
    "github.com/BurntSushi/toml": {"v1.5.0": 90},
    "github.com/containerd/containerd/v2": {"v2.2.7": 40},
    "go.opentelemetry.io/otel": {"v1.41.0": 90, "v1.47.0": 10},
    "go.opentelemetry.io/otel/metric": {"v1.41.0": 90, "v1.47.0": 10},
}
DOCKER_CLI = """RUN go mod edit -go=1.25.11 && \\
    # CVE-2026-34986: patched go-jose parsing.
    go get github.com/go-jose/go-jose/v4@v4.1.6 && \\
    go get golang.org/x/net@v0.62.0 && \\
    go get github.com/BurntSushi/toml@v1.5.0 && \\
    go get go.opentelemetry.io/otel@v1.41.0 go.opentelemetry.io/otel/metric@v1.41.0 && \\
    go mod edit -require=github.com/docker/docker@v29.3.1+incompatible && \\
    go mod vendor
"""
AGENT = """RUN go get golang.org/x/net@v0.61.0 && go get github.com/containerd/containerd/v2@v2.2.7
"""


def fetch(path):
    module, _, rest = path.partition("/@v/")
    module = module.replace("!b", "B").replace("!s", "S")
    if rest == "list":
        return "\n".join(RELEASES[module]) + "\n"
    version = rest.removesuffix(".info")
    published = NOW - datetime.timedelta(days=RELEASES[module][version])
    return json.dumps({"Version": version, "Time": published.isoformat().replace("+00:00", "Z")})


class BumpGoPinsTest(unittest.TestCase):
    def run_bump(self, *flags):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "platform/docker_images/agent").mkdir(parents=True)
            (root / "platform/Dockerfile").write_text(DOCKER_CLI)
            (root / "platform/docker_images/agent/Dockerfile").write_text(AGENT)
            with contextlib.redirect_stdout(io.StringIO()):
                bumps = BUMP.main(["bump", *flags], root=root, fetch=fetch, now=NOW)
            return bumps, (root / "platform/Dockerfile").read_text(), (root / "platform/docker_images/agent/Dockerfile").read_text()

    def test_main_takes_the_newest_release_old_enough_in_the_same_major(self):
        bumps, docker_cli, agent = self.run_bump()
        # v4.2.2 is 2 days old and v4.2.1-rc.1 a pre-release: v4.2.0 is the newest allowed.
        self.assertIn("go get github.com/go-jose/go-jose/v4@v4.2.0 && \\", docker_cli)
        # Every pin of a module gets the same version, including one behind the others.
        self.assertIn("go get golang.org/x/net@v0.63.0 && \\", docker_cli)
        self.assertIn("go get golang.org/x/net@v0.63.0 && go get", agent)
        self.assertEqual(bumps["golang.org/x/net"], ("v0.61.0", "v0.63.0"))
        # Up to date, and upper-case module paths are escaped for the proxy.
        self.assertNotIn("github.com/BurntSushi/toml", bumps)
        self.assertNotIn("github.com/containerd/containerd/v2", bumps)
        # Comments and other commands are left alone.
        self.assertIn("# CVE-2026-34986: patched go-jose parsing.", docker_cli)
        self.assertIn("go mod edit -go=1.25.11", docker_cli)

    def test_every_module_of_a_multi_module_go_get_moves(self):
        _, docker_cli, _ = self.run_bump()
        # Modules released together stay in step: a go get that bumps only the
        # first argument leaves otel@v1.47.0 needing a newer otel/metric.
        self.assertIn("go get go.opentelemetry.io/otel@v1.47.0 go.opentelemetry.io/otel/metric@v1.47.0 && \\", docker_cli)
        # module@version outside `go get` is not a pin.
        self.assertIn("go mod edit -require=github.com/docker/docker@v29.3.1+incompatible", docker_cli)

    def test_a_release_line_keeps_v1_and_later_modules_on_their_minor(self):
        bumps, docker_cli, _ = self.run_bump("--patch-only")
        self.assertIn("go get github.com/go-jose/go-jose/v4@v4.1.7 && \\", docker_cli)
        # golang.org/x modules ship fixes as v0 minors.
        self.assertIn("go get golang.org/x/net@v0.63.0 && \\", docker_cli)
        self.assertEqual(bumps["github.com/go-jose/go-jose/v4"], ("v4.1.6", "v4.1.7"))

    def test_check_prints_and_writes_nothing(self):
        bumps, docker_cli, agent = self.run_bump("--check")
        self.assertTrue(bumps)
        self.assertEqual((docker_cli, agent), (DOCKER_CLI, AGENT))

    def test_a_pin_never_moves_down(self):
        RELEASES["golang.org/x/crypto"] = {"v0.58.0": 30}
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "platform").mkdir()
                (root / "platform/Dockerfile").write_text("RUN go get golang.org/x/crypto@v0.60.0\n")
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(BUMP.main(["bump"], root=root, fetch=fetch, now=NOW), {})
        finally:
            del RELEASES["golang.org/x/crypto"]


if __name__ == "__main__":
    unittest.main()
