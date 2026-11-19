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

    def test_pnpm_runs_through_corepack_in_one_process(self):
        # Offline here: the default version is the one the image installed.
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "package.json"
            manifest.write_text('{"name": "probe", "private": true}\n')
            self.assertEqual(run("pnpm", "--version", cwd=directory).strip(), "11.28.7")
            # Corepack writes no pin into a repository that has none.
            self.assertNotIn("packageManager", manifest.read_text())
            # A pinned version that is installed runs in the pnpm process
            # itself, which corepack started (it sets COREPACK_ROOT before it
            # loads pnpm): the only process between this test and the probe.
            manifest.write_text('{"name": "probe", "private": true, "packageManager": "pnpm@11.28.7"}\n')
            probe = (
                "const fs = require('fs'); let pid = process.ppid, between = 0;"
                " while (pid > 1 && pid !== Number(process.env.TEST_PID)) { between++;"
                " pid = Number(/PPid:\\s+(\\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]); }"
                " console.log(between, process.env.COREPACK_ROOT ? 'corepack' : 'no-corepack');"
            )
            env = {key: value for key, value in os.environ.items() if key != "COREPACK_ROOT"}
            result = run("pnpm", "exec", "node", "-e", probe, cwd=directory,
                         env={**env, "TEST_PID": str(os.getpid())})
            self.assertEqual(result.strip(), "1 corepack")

    def test_playwright_driver_runs_on_the_image_node(self):
        # The wheel's own Node build lags Node's security releases, and the
        # image scan rejects it; the driver uses the image's Node instead.
        driver_node = Path(run(
            "/opt/agent-tools/bin/python", "-c",
            "import pathlib, playwright;"
            " print(pathlib.Path(playwright.__file__).parent / 'driver' / 'node')",
        ).strip())
        self.assertEqual(driver_node.resolve(), Path("/usr/local/bin/node").resolve())
        # The CLI starts the driver, so this runs it on the image's Node.
        self.assertTrue(run("playwright", "--version").startswith("Version "))
        # A session speaks the driver protocol and launches the image's Chromium.
        self.assertEqual(run(
            "/opt/agent-tools/bin/python", "-c",
            "from playwright.sync_api import sync_playwright\n"
            "with sync_playwright() as p:\n"
            "    browser = p.chromium.launch()\n"
            "    page = browser.new_page()\n"
            "    page.set_content('<p>ok</p>')\n"
            "    print(page.text_content('p'))\n"
            "    browser.close()",
        ).strip(), "ok")

    def test_launchers_describe_the_machine_after_the_agent_prompt(self):
        prompt = run("archestra-agent-instructions",
                     env={**os.environ, "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT": "Review the release."})
        self.assertTrue(prompt.startswith("Review the release.\n\n# This machine"))
        alone = run("archestra-agent-instructions",
                    env={**os.environ, "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT": ""})
        self.assertTrue(alone.startswith("# This machine"))


if __name__ == "__main__":
    unittest.main()
