"""Exercise the shared tools offline as the runtime user, with a fresh HOME.

Run during agent-base builds on both native architectures. The GitHub CLI,
browser, recorder and encoders are real; no accounts or model calls are needed.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


class ToolchainTest(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 1000, "exercise tools as the runtime user")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "GIT_CONFIG_GLOBAL": str(self.home / ".gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GH_CONFIG_DIR": str(self.home / ".config/gh"),
            "OPENAI_BASE_URL": "",
            "OTEL_SDK_DISABLED": "true",
        }

    def run_tool(self, *args, **kwargs):
        try:
            return subprocess.run(
                args, cwd=self.root, env=self.env, text=True, capture_output=True,
                check=True, timeout=90, **kwargs,
            )
        except subprocess.CalledProcessError as error:
            # All inputs are local fixtures; expose diagnostics on image-build
            # failures, including missing browser libraries or encoder errors.
            print(error.stdout, error.stderr, flush=True)
            raise

    def test_git_uses_refreshed_github_credentials(self):
        credentials = self.root / "credentials.json"
        self.env.update({
            "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "toolchain-test",
            "ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE": str(credentials),
            "GH_TOKEN": "stale-fixture",
        })
        request = "protocol=https\nhost=github.com\n\n"
        for token in ("first-fixture", "refreshed-fixture"):
            credentials.write_text(json.dumps({
                "taskId": "toolchain-test",
                "credentials": {"GITHUB_TOKEN": {
                    "value": token, "expiresAt": time.time() * 1000 + 60_000,
                }},
            }))
            self.run_tool("archestra-agent-init")
            # Derived images and skills can configure Git again after init.
            self.run_tool("gh", "auth", "setup-git", "--hostname", "github.com")
            result = self.run_tool("git", "credential", "fill", input=request)
            self.assertIn(f"password={token}\n", result.stdout)
        credentials.write_text(json.dumps({
            "taskId": "toolchain-test",
            "credentials": {"GITHUB_TOKEN": {"value": "expired-fixture", "expiresAt": 1}},
        }))
        self.env["GIT_TERMINAL_PROMPT"] = "0"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_tool("git", "credential", "fill", input=request)

    def test_nitpicker_initializes_without_a_repository_or_provider_call(self):
        # init writes a usable configuration without making an inference call.
        self.env["OPENAI_API_KEY"] = "unused-fixture"
        self.run_tool("nitpicker", "init", "--global", "--free")
        self.assertTrue(list(self.home.rglob("*.toml")))
        self.assertIn("--review-timeout-seconds", self.run_tool("nitpicker", "--help").stdout)

    def test_uv_creates_a_writable_project_environment(self):
        venv = self.root / "project-venv"
        self.run_tool("uv", "venv", "--offline", "--python", "/usr/bin/python3", str(venv))
        self.run_tool(str(venv / "bin/python"), "-c", "import tomllib; print('ready')")

    def test_browser_records_and_encodes_a_captioned_video(self):
        page = self.root / "index.html"
        page.write_text("""<!doctype html><html><body>
<button onclick="document.querySelector('p').textContent='Complete'">Run</button>
<p>Ready</p></body></html>""")
        screenshot = self.root / "screenshot.png"
        self.run_tool("shot-scraper", "shot", str(page), "-o", str(screenshot),
                      "--width", "320", "--height", "240")
        self.assertEqual(screenshot.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        raw = self.root / "raw.webm"
        storyboard = self.root / "storyboard.json"
        # JSON is valid YAML, avoiding test-only formatting dependencies.
        storyboard.write_text(json.dumps({
            "url": str(page), "output": str(raw),
            "viewport": {"width": 320, "height": 240},
            "scenes": [{"name": "Complete an action", "do": [
                {"click": "button"}, {"wait_for": "text=Complete"}, {"pause": 0.5},
            ]}],
        }))
        self.run_tool("shot-scraper", "video", str(storyboard))
        subtitles = self.root / "captions.srt"
        subtitles.write_text("1\n00:00:00,000 --> 00:00:05,000\nAction complete\n")
        output = self.root / "captioned.mp4"
        self.run_tool("ffmpeg", "-nostdin", "-y", "-i", str(raw),
                      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000",
                      "-vf", f"subtitles={subtitles}", "-c:v", "libx264",
                      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(output))
        media = json.loads(self.run_tool(
            "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output),
        ).stdout)
        self.assertGreater(float(media["format"]["duration"]), 0)
        self.assertEqual({stream["codec_name"] for stream in media["streams"]}, {"h264", "aac"})


if __name__ == "__main__":
    unittest.main()
