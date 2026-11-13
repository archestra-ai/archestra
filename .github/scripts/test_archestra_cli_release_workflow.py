"""Run the release steps of build-archestra-cli.yml with a fake `gh`, and check the workflow's policy."""

import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/build-archestra-cli.yml").read_text()
SPEC = importlib.util.spec_from_file_location(
    "archestra_cli_release_lock", Path(__file__).with_name("archestra-cli-release-lock.py"),
)
writer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(writer)

JOBS = dict(re.findall(r"^  ([a-z-]+):\n((?:    .*\n|\n|  #.*\n)+)", WORKFLOW.split("\njobs:\n", 1)[1], re.M))
CHECK = importlib.util.spec_from_file_location(
    "archestra_cli_version_check", Path(__file__).with_name("archestra-cli-version-check.py"),
)
check = importlib.util.module_from_spec(CHECK)
CHECK.loader.exec_module(check)
MAIN_VERSION = check.package_version((ROOT / check.MANIFEST).read_text())
VERSION = "9.8.7"
TAG = "archestra-cli-v9.8.7"
SHA = "c" * 40


def run_script(job, name):
    """The `run: |` script of a named step."""
    step = JOBS[job].split(f"      - name: {name}\n", 1)[1]
    lines = step.split("        run: |\n", 1)[1].splitlines()
    script = []
    for line in lines:
        if line.strip() and not line.startswith(" " * 10):
            break
        script.append(line[10:])
    return "\n".join(script)


def content(name):
    return f"binary of {name}\n".encode()


class ReleaseStepTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.work = root / "work"
        self.runner = root / "runner"
        self.binaries = root / "bin"
        self.calls = root / "gh-calls"
        self.output = root / "github-output"
        for directory in (self.work, self.runner, self.binaries):
            directory.mkdir()
        (self.work / ".github").symlink_to(ROOT / ".github")
        # Answers `gh api` per path, lists the drafts it is told about, and
        # records every call. An upload also records the files it was given.
        gh = self.binaries / "gh"
        gh.write_text(
            "#!/bin/bash\n"
            'printf "%s\\n" "$*" >> "$ARCHESTRA_TEST_GH_CALLS"\n'
            'case "$1 $2" in\n'
            '  "api repos/archestra-ai/archestra/releases/tags/"*) answer="$ARCHESTRA_TEST_RELEASE" ;;\n'
            '  "api repos/archestra-ai/archestra/git/ref/tags/"*) answer="$ARCHESTRA_TEST_TAG" ;;\n'
            '  "release list") printf "%s" "$ARCHESTRA_TEST_DRAFTS"; exit 0 ;;\n'
            '  "release upload")\n'
            "    shift 3\n"
            '    for file in "$@"; do\n'
            '      if [ -f "$file" ]; then cp "$file" "$ARCHESTRA_TEST_UPLOADS/"; fi\n'
            "    done\n"
            "    exit 0 ;;\n"
            '  "release create") exit "$ARCHESTRA_TEST_CREATE_STATUS" ;;\n'
            '  "release "*) exit 0 ;;\n'
            "  *) answer=unexpected ;;\n"
            "esac\n"
            'case "$answer" in\n'
            "  found) exit 0 ;;\n"
            '  missing) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\n'
            '  *) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;\n'
            "esac\n"
        )
        gh.chmod(0o755)
        self.uploads = root / "uploads"
        self.uploads.mkdir()

    def run_step(self, job, name, cwd, **env):
        self.calls.unlink(missing_ok=True)
        self.output.unlink(missing_ok=True)
        result = subprocess.run(
            ["bash", "-c", run_script(job, name)], cwd=cwd, capture_output=True, text=True,
            env=os.environ | {
                "PATH": f"{self.binaries}:{os.environ['PATH']}",
                "GITHUB_REPOSITORY": "archestra-ai/archestra", "GITHUB_SHA": SHA,
                "GITHUB_OUTPUT": str(self.output), "RUNNER_TEMP": str(self.runner),
                "ARCHESTRA_TEST_GH_CALLS": str(self.calls), "ARCHESTRA_TEST_UPLOADS": str(self.uploads),
                "ARCHESTRA_TEST_RELEASE": "missing", "ARCHESTRA_TEST_TAG": "missing",
                "ARCHESTRA_TEST_DRAFTS": "", "ARCHESTRA_TEST_CREATE_STATUS": "0",
                "VERSION": VERSION, "TAG": TAG,
            } | env,
        )
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        outputs = dict(
            line.split("=", 1) for line in (self.output.read_text().splitlines() if self.output.exists() else [])
        )
        return result, calls, outputs

    def release_state(self, **env):
        return self.run_step("publish", "Read the version and whether it is published", ROOT, **env)

    def publish(self, **env):
        return self.run_step("publish", "Create and publish release", self.work, **env)

    def build_outputs(self, names=None):
        dist = self.work / "dist"
        dist.mkdir(exist_ok=True)
        for name in writer.FILES if names is None else names:
            (dist / name).write_bytes(content(name))

    def test_unpublished_version_is_to_be_published(self):
        result, calls, outputs = self.release_state()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {
            "version": MAIN_VERSION, "tag": f"archestra-cli-v{MAIN_VERSION}", "published": "false",
        })
        self.assertEqual(len(calls), 2)

    def test_published_version_is_skipped(self):
        result, calls, outputs = self.release_state(ARCHESTRA_TEST_RELEASE="found")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs["published"], "true")
        self.assertEqual(len(calls), 1)

    def test_a_tag_without_a_release_and_a_failed_request_stop_the_job(self):
        for release, tag, expected in (
            ("missing", "found", "exists without a published release"),
            ("broken", "missing", "HTTP 502"),
            ("missing", "broken", "HTTP 502"),
        ):
            with self.subTest(release=release, tag=tag):
                result, _, outputs = self.release_state(ARCHESTRA_TEST_RELEASE=release, ARCHESTRA_TEST_TAG=tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error::", result.stdout)
                self.assertIn(expected, result.stdout)
                self.assertNotIn("published", outputs)

    def test_release_is_a_draft_until_its_seven_files_are_uploaded(self):
        self.build_outputs()
        result, calls, _ = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        notes = self.runner / "notes.md"
        self.assertEqual(calls, [
            "release list --repo archestra-ai/archestra --json tagName,isDraft "
            f'--jq .[] | select(.isDraft and .tagName == "{TAG}") | .tagName',
            f"release create {TAG} --repo archestra-ai/archestra --target {SHA} "
            f"--title Archestra CLI v{VERSION} --notes-file {notes} --draft",
            f"release upload {TAG} " + " ".join(f"dist/{name}" for name in writer.FILES)
            + " dist/SHA256SUMS --repo archestra-ai/archestra",
            f"release edit {TAG} --repo archestra-ai/archestra --draft=false --latest=false",
        ])
        sums = "".join(f"{hashlib.sha256(content(name)).hexdigest()}  {name}\n" for name in writer.FILES)
        self.assertEqual(sorted(entry.name for entry in self.uploads.iterdir()), sorted([*writer.FILES, "SHA256SUMS"]))
        self.assertEqual((self.uploads / "SHA256SUMS").read_text(), sums)
        self.assertEqual(writer.parse_sums(sums), {name: hashlib.sha256(content(name)).hexdigest() for name in writer.FILES})
        text = notes.read_text()
        self.assertIn(f"`archestra` v{VERSION}", text)
        self.assertIn(SHA, text)
        self.assertIn("```\n" + sums + "```\n", text)

    def test_leftover_draft_is_replaced(self):
        self.build_outputs()
        result, calls, _ = self.publish(ARCHESTRA_TEST_DRAFTS=TAG + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1], f"release delete {TAG} --repo archestra-ai/archestra --yes")
        self.assertTrue(calls[2].startswith(f"release create {TAG} "))

    def test_missing_or_unexpected_file_publishes_nothing(self):
        for names in (writer.FILES[:-1], (*writer.FILES, "archestra-linux-riscv64")):
            with self.subTest(names=len(names)):
                for entry in (self.work / "dist").iterdir() if (self.work / "dist").exists() else []:
                    entry.unlink()
                self.build_outputs(names)
                result, calls, _ = self.publish()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call.startswith(("release create", "release upload", "release edit")) for call in calls))

    def test_failed_draft_creation_publishes_nothing(self):
        self.build_outputs()
        result, calls, _ = self.publish(ARCHESTRA_TEST_CREATE_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(calls[-1].startswith("release create "))

    def test_published_version_fails_only_when_main_has_changes_it_lacks(self):
        root = Path(self.temp.name)
        origin = root / "origin"
        env = os.environ | {"GIT_CONFIG_GLOBAL": str(root / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}

        def git(*args, cwd=origin):
            subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)

        def write(name, text):
            target = origin / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)

        origin.mkdir()
        git("init", "-q", "-b", "main")
        git("config", "user.email", "ci@example.test")
        git("config", "user.name", "CI")
        write(
            ".github/scripts/archestra-cli-version-check.py",
            (ROOT / ".github/scripts/archestra-cli-version-check.py").read_text(),
        )
        write("platform/archestra-cli/Cargo.toml", f'[package]\nname = "archestra_cli"\nversion = "{VERSION}"\n')
        write("platform/archestra-cli/src/main.rs", "fn main() {}\n")
        git("add", "-A")
        git("commit", "-qm", "released")
        git("tag", TAG)
        for change, text, passes in (
            ("platform/archestra-cli/README.md", "# archestra\n", True),
            ("platform/archestra-cli/src/main.rs", "fn main() { println!(); }\n", False),
        ):
            with self.subTest(change=change):
                write(change, text)
                git("add", "-A")
                git("commit", "-qm", "later")
                checkout = root / f"checkout-{passes}"
                # As actions/checkout leaves it: the head commit alone, no tags.
                git("clone", "-q", "--depth=1", "--no-tags", origin.as_uri(), str(checkout), cwd=root)
                result, _, _ = self.run_step(
                    "publish", "Skip a published version", checkout,
                    ARCHESTRA_TEST_RELEASE="found", GH_TOKEN="fixture", GITHUB_ACTIONS="true", **{
                        key: env[key] for key in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM")
                    },
                )
                self.assertIn(f"::notice::{TAG} is already published", result.stdout)
                self.assertEqual(result.returncode == 0, passes, result.stderr)
                if not passes:
                    self.assertIn(f"{VERSION} is already released as {TAG}", result.stderr)
                    self.assertIn("platform/archestra-cli/src/main.rs", result.stderr)

    def test_lock_job_proceeds_only_for_the_version_on_main(self):
        for released, proceed in ((MAIN_VERSION, "true"), ("0.0.0", "false")):
            with self.subTest(released=released):
                result, _, outputs = self.run_step("lock", "Check main still has this version", ROOT, VERSION=released)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(outputs, {"proceed": proceed})

    def test_summary_gives_the_command_that_writes_the_lock_by_hand(self):
        summary = Path(self.temp.name) / "summary"
        result, _, _ = self.run_step("publish", "Describe the lock update", self.work, GITHUB_STEP_SUMMARY=str(summary))
        self.assertEqual(result.returncode, 0, result.stderr)
        text = summary.read_text()
        self.assertIn(f"gh release download {TAG} --repo archestra-ai/archestra --pattern SHA256SUMS --dir /tmp/{TAG}\n", text)
        command = f"python3 .github/scripts/archestra-cli-release-lock.py --version {VERSION} --sums /tmp/{TAG}/SHA256SUMS"
        self.assertIn(command + "\n", text)
        # The printed command is one the writer accepts.
        self.build_outputs()
        listed = Path(self.temp.name) / "SHA256SUMS"
        listed.write_text("".join(f"{hashlib.sha256(content(name)).hexdigest()}  {name}\n" for name in writer.FILES))
        lock = Path(self.temp.name) / "release.lock.json"
        arguments = command.replace(f"/tmp/{TAG}/SHA256SUMS", str(listed)).split()[1:]
        subprocess.run(["python3", *arguments, "--output", str(lock)], cwd=ROOT, check=True, capture_output=True)
        self.assertIn(f'"version": "{VERSION}"', lock.read_text())


class LockPullRequestTests(unittest.TestCase):
    """The lock job's steps against a real remote. `gh` is the only fake."""

    BRANCH = "automation/archestra-cli-release-lock"
    LOCK_FILE = "platform/archestra-cli/release.lock.json"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.origin = root / "origin.git"
        self.checkout = root / "checkout"
        self.binaries = root / "bin"
        self.calls = root / "gh-calls"
        self.summary = root / "summary"
        self.binaries.mkdir()
        gh = self.binaries / "gh"
        gh.write_text(
            "#!/bin/bash\n"
            'printf "%s\\n" "$*" >> "$ARCHESTRA_TEST_GH_CALLS"\n'
            'case "$1 $2" in\n'
            '  "api repos/archestra-ai/archestra/pulls?state=open&head=archestra-ai:automation/archestra-cli-release-lock&base=main&per_page=1")\n'
            '    printf "%s" "$ARCHESTRA_TEST_EXISTING_PR" ;;\n'
            '  "pr create") echo "https://github.com/archestra-ai/archestra/pull/77" ;;\n'
            '  "pr view") echo "Lock pull request: https://github.com/archestra-ai/archestra/pull/77" ;;\n'
            '  "pr edit"|"auth setup-git") ;;\n'
            "  *) exit 1 ;;\n"
            "esac\n"
        )
        gh.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.binaries}:{os.environ['PATH']}",
            "GIT_CONFIG_GLOBAL": str(root / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1",
            "ARCHESTRA_TEST_GH_CALLS": str(self.calls), "ARCHESTRA_TEST_EXISTING_PR": "",
            "GITHUB_REPOSITORY": "archestra-ai/archestra", "GH_REPO": "archestra-ai/archestra",
            "GITHUB_STEP_SUMMARY": str(self.summary),
            "BRANCH": self.BRANCH, "LOCK_FILE": self.LOCK_FILE,
        }
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin), cwd=root)
        self.git("clone", "-q", str(self.origin), str(self.checkout), cwd=root)
        self.git("config", "user.email", "developer@example.test")
        self.git("config", "user.name", "Developer")
        scripts = self.checkout / ".github/scripts"
        scripts.mkdir(parents=True)
        for name in ("archestra-cli-release-lock.py", "archestra-cli-version-check.py"):
            (scripts / name).write_text((ROOT / ".github/scripts" / name).read_text())
        lock = self.checkout / self.LOCK_FILE
        lock.parent.mkdir(parents=True)
        lock.write_text(writer.render(writer.EMPTY))
        (lock.parent / "Cargo.toml").write_text('[package]\nname = "archestra_cli"\nversion = "0.2.0"\n')
        self.git("add", "-A")
        self.git("commit", "-qm", "initial")
        self.git("push", "-q", "origin", "HEAD:main")

    def git(self, *args, cwd=None):
        return subprocess.check_output(
            ["git", *args], cwd=cwd or self.checkout, text=True, stderr=subprocess.STDOUT,
            env=getattr(self, "env", None),
        ).strip()

    def release(self, version):
        """The published files of a version, as `gh release download` leaves them."""
        self.runs = getattr(self, "runs", 0) + 1
        runner = Path(self.temp.name) / f"runner-{self.runs}"
        directory = runner / "release"
        directory.mkdir(parents=True)
        for name in writer.FILES:
            (directory / name).write_bytes(content(name) + version.encode())
        (directory / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256(content(name) + version.encode()).hexdigest()}  {name}\n" for name in writer.FILES
        ))
        return runner

    def run_lock_job(self, version, existing_pr=""):
        """The job's steps in order, in a fresh checkout as on a new runner."""
        self.calls.unlink(missing_ok=True)
        self.summary.unlink(missing_ok=True)
        runner = self.release(version)
        checkout = runner / "checkout"
        self.git("clone", "-q", str(self.origin), str(checkout), cwd=runner)
        env = self.env | {
            "RUNNER_TEMP": str(runner), "VERSION": version, "TAG": f"archestra-cli-v{version}",
            "ARCHESTRA_TEST_EXISTING_PR": existing_pr, "GH_TOKEN": "fixture",
        }
        subprocess.run(
            ["bash", str(ROOT / ".github/actions/configure-git-identity/configure.sh")],
            cwd=checkout, env=env, check=True,
        )
        outputs = {}
        for name in (
            "Check main still has this version", "Prepare automation branch", "Write the release lock",
            "Commit and push update", "Open or update pull request",
        ):
            if name != "Check main still has this version" and outputs.get("proceed") != "true":
                continue
            if name == "Commit and push update" and outputs.get("changed") != "true":
                continue
            output = runner / "output"
            output.unlink(missing_ok=True)
            result = subprocess.run(
                ["bash", "-c", run_script("lock", name)], cwd=checkout, capture_output=True, text=True,
                env=env | {"GITHUB_OUTPUT": str(output), "TARGET": outputs.get("path", "")},
            )
            self.assertEqual(result.returncode, 0, f"{name}: {result.stderr}")
            if output.exists():
                outputs.update(line.split("=", 1) for line in output.read_text().splitlines())
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        return outputs, calls

    def remote(self, *args):
        return self.git("--git-dir", str(self.origin), *args, cwd=Path(self.temp.name))

    def test_lock_pull_request_is_opened_from_the_automation_branch(self):
        outputs, calls = self.run_lock_job("0.2.0")
        self.assertEqual(outputs["changed"], "true")
        self.assertEqual(self.remote("diff", "--name-only", "main", self.BRANCH), self.LOCK_FILE)
        self.assertEqual(self.remote("rev-list", "--count", f"main..{self.BRANCH}"), "1")
        self.assertEqual(
            self.remote("log", "-1", "--format=%an <%ae>|%s", self.BRANCH),
            "archestra-automation-prs[bot] <222894074+archestra-automation-prs[bot]@users.noreply.github.com>|"
            "chore: update Archestra CLI release lock to v0.2.0",
        )
        lock = self.remote("show", f"{self.BRANCH}:{self.LOCK_FILE}")
        self.assertEqual(lock + "\n", writer.render(writer.build("0.2.0", {
            name: hashlib.sha256(content(name) + b"0.2.0").hexdigest() for name in writer.FILES
        })))
        created = [call for call in calls if call.startswith("pr create ")]
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].startswith(
            f"pr create --base main --head {self.BRANCH} --title chore: update Archestra CLI release lock to v0.2.0 --body Pin "
        ))
        self.assertFalse(any(call.startswith("pr merge") for call in calls))
        self.assertIn("Lock pull request: https://github.com/archestra-ai/archestra/pull/77", self.summary.read_text())

    def test_open_pull_request_moves_to_the_next_version(self):
        self.run_lock_job("0.2.0")
        (self.checkout / "platform/archestra-cli/Cargo.toml").write_text('[package]\nname = "archestra_cli"\nversion = "0.3.0"\n')
        self.git("commit", "-qam", "bump")
        self.git("push", "-q", "origin", "HEAD:main")
        outputs, calls = self.run_lock_job("0.3.0", existing_pr="77")
        self.assertEqual(outputs["changed"], "true")
        self.assertEqual(self.remote("diff", "--name-only", "main", self.BRANCH), self.LOCK_FILE)
        self.assertIn('"version": "0.3.0"', self.remote("show", f"{self.BRANCH}:{self.LOCK_FILE}"))
        self.assertTrue(any(call.startswith("pr edit 77 --title chore: update Archestra CLI release lock to v0.3.0 ") for call in calls))
        self.assertFalse(any(call.startswith("pr create") for call in calls))

    def test_rerun_after_the_merge_and_a_run_for_an_older_version_change_nothing(self):
        self.run_lock_job("0.2.0")
        self.remote("update-ref", "refs/heads/main", f"refs/heads/{self.BRANCH}")
        before = self.remote("rev-parse", self.BRANCH)
        outputs, calls = self.run_lock_job("0.2.0")
        self.assertEqual(outputs["changed"], "false")
        self.assertEqual(self.remote("rev-parse", self.BRANCH), before)
        self.assertFalse(any(call.startswith("pr ") for call in calls))
        outputs, calls = self.run_lock_job("0.1.0")
        self.assertEqual(outputs, {"proceed": "false"})
        self.assertEqual(calls, [])


class WorkflowPolicyTests(unittest.TestCase):
    def test_jobs(self):
        self.assertEqual(list(JOBS), ["version", "build", "publish", "lock"])

    def test_every_action_is_pinned_by_commit_or_is_this_repository_s_own(self):
        uses = re.findall(r"^\s+(?:- )?uses: (\S+)", WORKFLOW, re.M)
        self.assertTrue(uses)
        for action in uses:
            with self.subTest(action=action):
                self.assertRegex(action, r"^(\$/\.github/actions/[a-z-]+|[\w.-]+/[\w./-]+@[0-9a-f]{40})$")

    def test_pinned_actions_are_ones_other_workflows_already_use(self):
        others = "".join(
            path.read_text() for path in (ROOT / ".github/workflows").glob("*.yml")
            if path.name != "build-archestra-cli.yml"
        )
        for line in re.findall(r"^\s+(?:- )?uses: (\S+@[0-9a-f]{40} # \S+)$", WORKFLOW, re.M):
            with self.subTest(action=line):
                self.assertTrue(line in others)

    def test_permissions_are_minimal_and_credentials_never_persist(self):
        self.assertTrue("\npermissions: {}\n" in WORKFLOW)
        permissions = {
            job: re.findall(r"^      ([a-z-]+): (read|write)\b", text.split("    permissions:\n", 1)[1].split("\n    ", 1)[0] + "\n", re.M)
            for job, text in JOBS.items()
        }
        self.assertEqual(permissions, {
            "version": [("contents", "read")], "build": [("contents", "read")],
            "publish": [("contents", "write")], "lock": [("contents", "read")],
        })
        self.assertEqual(WORKFLOW.count("uses: actions/checkout@"), WORKFLOW.count("persist-credentials: false"))
        for job, text in JOBS.items():
            with self.subTest(job=job):
                self.assertEqual("ARCHESTRA_RELEASER_GITHUB_APP" in text, job == "lock")
                self.assertTrue("timeout-minutes: " in text)
        # The job that holds the App key runs no cargo and no build output.
        self.assertFalse("cargo" in JOBS["lock"] or "github-download-artifact" in JOBS["lock"])

    def test_only_the_main_branch_of_this_repository_publishes(self):
        condition = (
            "    if: >-\n"
            "      github.repository == 'archestra-ai/archestra'\n"
            "      && github.ref == 'refs/heads/main'\n"
            "      && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')\n"
        )
        for job in ("publish", "lock"):
            with self.subTest(job=job):
                self.assertTrue(condition in JOBS[job])
        self.assertTrue("    needs: [build]\n" in JOBS["publish"])
        self.assertTrue("    needs: [publish]\n" in JOBS["lock"])
        self.assertTrue("    if: github.event_name == 'pull_request'\n" in JOBS["version"])
        # Both triggers are for main: nothing is built or published from another branch's pushes.
        triggers = WORKFLOW.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertEqual(re.findall(r"^  ([a-z_]+):", triggers, re.M), ["push", "pull_request", "workflow_dispatch"])
        self.assertEqual(triggers.count("    branches: [main]\n"), 2)
        self.assertTrue("github.event_name != 'pull_request'\n" in JOBS["build"])
        self.assertTrue("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n" in WORKFLOW)

    def test_matrix_builds_the_six_served_files_from_locked_sources_without_a_cache(self):
        build = JOBS["build"]
        rows = re.findall(r"- target: (\S+)\n\s+runner: (\S+)\n\s+file: (\S+)\n", build)
        self.assertEqual(sorted(rows), sorted([
            ("aarch64-apple-darwin", "macos-latest", "archestra-darwin-arm64"),
            ("x86_64-apple-darwin", "macos-latest", "archestra-darwin-x86_64"),
            ("aarch64-unknown-linux-musl", "ubuntu-24.04-arm-32core", "archestra-linux-arm64"),
            ("x86_64-unknown-linux-musl", "ubuntu-24.04", "archestra-linux-x86_64"),
            ("aarch64-pc-windows-msvc", "windows-latest", "archestra-windows-arm64.exe"),
            ("x86_64-pc-windows-msvc", "windows-latest", "archestra-windows-x86_64.exe"),
        ]))
        self.assertEqual(tuple(sorted(row[2] for row in rows)), writer.FILES)
        self.assertTrue('        run: cargo build --release --locked --target "$TARGET"\n' in build)
        self.assertTrue('          cache: "false"\n' in build)
        self.assertTrue('      AWS_LC_SYS_PREBUILT_NASM: "1"\n' in build)

    def test_rename_step_gives_each_target_its_served_name(self):
        for target, name in (
            ("aarch64-apple-darwin", "archestra-darwin-arm64"),
            ("x86_64-unknown-linux-musl", "archestra-linux-x86_64"),
            ("aarch64-pc-windows-msvc", "archestra-windows-arm64.exe"),
        ):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                built = Path(directory) / "target" / target / "release"
                built.mkdir(parents=True)
                (built / ("archestra.exe" if "windows" in target else "archestra")).write_bytes(content(name))
                subprocess.run(
                    ["bash", "-c", run_script("build", "Rename to the served file name")], cwd=directory,
                    check=True, capture_output=True, env=os.environ | {"TARGET": target, "FILE": name},
                )
                self.assertEqual((Path(directory) / "target/served" / name).read_bytes(), content(name))


if __name__ == "__main__":
    unittest.main()
