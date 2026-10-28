"""Check the composite action's identity scope using real Git repositories."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


CONFIGURE = Path(__file__).resolve().parents[1] / "actions/configure-git-identity/configure.sh"


class GitIdentityTests(unittest.TestCase):
    def test_identity_is_local_and_inherited_by_linked_worktrees(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, "GIT_CONFIG_GLOBAL": str(root / "global.gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}

            def git(*args, cwd=root):
                return subprocess.check_output(["git", *args], cwd=cwd, env=env, text=True).strip()

            git("config", "--global", "user.name", "Developer fixture")
            git("config", "--global", "user.email", "developer@example.invalid")
            checkout = root / "primary checkout"
            unrelated = root / "unrelated checkout"
            linked = root / "linked worktree"
            git("init", "-q", str(checkout))
            git("init", "-q", str(unrelated))
            git("commit", "--allow-empty", "-qm", "initial", cwd=checkout)
            git("worktree", "add", "--quiet", "--detach", str(linked), "HEAD", cwd=checkout)

            subprocess.run(["bash", str(CONFIGURE)], cwd=checkout, env=env, check=True)
            git("commit", "--allow-empty", "-qm", "automated change", cwd=linked)
            self.assertEqual(
                git("show", "-s", "--format=%an <%ae>|%cn <%ce>", cwd=linked),
                "archestra-ci[bot] <222894074+archestra-ci[bot]@users.noreply.github.com>|"
                "archestra-ci[bot] <222894074+archestra-ci[bot]@users.noreply.github.com>",
            )
            self.assertEqual(git("config", "user.name", cwd=unrelated), "Developer fixture")
            self.assertEqual(git("config", "--global", "user.email"), "developer@example.invalid")


if __name__ == "__main__":
    unittest.main()
