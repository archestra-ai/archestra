"""The shared base runs a project's database and native builds without root."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


def run(*command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, text=True, **kwargs).stdout


class DevelopmentToolsTest(unittest.TestCase):
    def test_postgres_with_pgvector_runs_as_the_agent_user(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "postgres"
            run("initdb", "-D", str(data), "-U", "node")
            run("pg_ctl", "-D", str(data), "-l", str(Path(directory) / "log"), "-w", "start")
            try:
                # The default socket directory needs no flags, and HNSW indexes
                # need a newer pgvector than Debian bookworm ships.
                run("psql", "-U", "node", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
                    "CREATE EXTENSION vector; CREATE TABLE items (embedding vector(3));"
                    " CREATE INDEX ON items USING hnsw (embedding vector_l2_ops);")
            finally:
                run("pg_ctl", "-D", str(data), "-w", "stop")

    def test_cargo_builds_native_code_against_openssl(self):
        run("pkg-config", "--exists", "openssl")
        with tempfile.TemporaryDirectory() as directory:
            run("cargo", "new", "--quiet", "--bin", "probe", cwd=directory)
            project = Path(directory) / "probe"
            run("cargo", "build", "--quiet", "--offline", cwd=project)
            self.assertEqual(run(str(project / "target/debug/probe")).strip(), "Hello, world!")

    def test_launchers_describe_the_machine_after_the_agent_prompt(self):
        prompt = run("archestra-agent-instructions",
                     env={**os.environ, "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT": "Review the release."})
        self.assertTrue(prompt.startswith("Review the release.\n\n# This machine"))
        alone = run("archestra-agent-instructions",
                    env={**os.environ, "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT": ""})
        self.assertTrue(alone.startswith("# This machine"))


if __name__ == "__main__":
    unittest.main()
