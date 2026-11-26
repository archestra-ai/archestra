"""Tests for stable-line.py, with GitHub faked at the `gh` binary."""

import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("stable-line.py")
SPEC = importlib.util.spec_from_file_location("stable_line", SCRIPT)
stable_line = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stable_line)

REPO = "o/r"
CONFIG = Path(__file__).resolve().parents[1] / "release-please" / "release-please-config.json"
DEPENDABOT = (Path(__file__).resolve().parents[1] / "dependabot.yml").read_text()

# A `gh` that answers from a JSON world file and logs each call. `api` GETs read
# world[path]; PUT/PATCH replace it; POST git/refs creates the ref; other writes
# answer world["METHOD path"]. {"__status": N} answers with an HTTP error, and a
# {"__seq": [...]} entry answers its items in turn.
FAKE_GH = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, sys
    world_path, log_path = os.environ["FAKE_GH_WORLD"], os.environ["FAKE_GH_LOG"]
    world = json.load(open(world_path))
    args = sys.argv[1:]
    body = sys.stdin.read() if "--input" in args else None
    with open(log_path, "a") as log:
        log.write(json.dumps({"args": args, "body": json.loads(body) if body else None}) + "\n")
    if args[0] == "pr":
        sys.exit(0)
    path = args[1]
    method = args[args.index("--method") + 1] if "--method" in args else "GET"

    def answer(value):
        if isinstance(value, dict) and "__seq" in value:
            item = value["__seq"].pop(0)
            json.dump(world, open(world_path, "w"))
            value = item
        if isinstance(value, dict) and "__status" in value:
            sys.stderr.write(f"gh: {value.get('message', 'error')} (HTTP {value['__status']})\n")
            sys.exit(1)
        sys.stdout.write(value if isinstance(value, str) else json.dumps(value))

    if method == "GET":
        if path not in world:
            sys.stderr.write(f"unexpected call {path}\n")
            sys.exit(2)
        answer(world[path])
    elif method in ("PUT", "PATCH") and f"{method} {path}" not in world:
        payload = json.loads(body)
        world[path] = {**world.get(path, {}), **payload}
        json.dump(world, open(world_path, "w"))
        answer(world[path])
    elif method == "POST" and path.endswith("/git/refs") and f"POST {path}" not in world:
        payload = json.loads(body)
        world[path.replace("/git/refs", "/git/ref/") + payload["ref"].removeprefix("refs/")] = {"object": {"sha": payload["sha"]}}
        json.dump(world, open(world_path, "w"))
        answer({"ref": payload["ref"]})
    else:
        key = f"{method} {path}"
        if key not in world:
            sys.stderr.write(f"unexpected call {key}\n")
            sys.exit(2)
        answer(world[key])
''').lstrip()

NOT_FOUND = {"__status": 404, "message": "Not Found"}
QUEUE_PARAMS = {"merge_method": "SQUASH", "max_entries_to_build": 10}
REQUIRED = [{"context": "Build", "integration_id": 15368}, {"context": "Supply Chain Policy", "integration_id": 15368}]


def api(path):
    return f"repos/{REPO}/{path}"


def contents(path, ref):
    from urllib.parse import quote, urlencode
    return api(f"contents/{quote(path)}?{urlencode({'ref': ref})}")


def pages(path, query=""):
    return api(f"{path}?{query + '&' if query else ''}per_page=100")


def ruleset(rid, include, rules, bypass=()):
    return {
        "id": rid, "name": f"ruleset {rid}", "target": "branch", "enforcement": "active",
        "source": REPO, "source_type": "Repository", "node_id": "x", "_links": {},
        "created_at": "t", "updated_at": "t", "current_user_can_bypass": "never",
        "bypass_actors": list(bypass),
        "conditions": {"ref_name": {"include": include, "exclude": []}},
        "rules": rules,
    }


def core_ruleset():
    return ruleset(10, ["refs/heads/release/*"], [
        {"type": "pull_request", "parameters": {"required_approving_review_count": 0}},
        {"type": "required_status_checks", "parameters": {
            "do_not_enforce_on_create": False, "strict_required_status_checks_policy": False,
            "required_status_checks": REQUIRED,
        }},
    ])


def world():
    """A repository on 1.5.0-rc.44 with release/1.4 supported and the infra queue for 1.5 applied."""
    config = CONFIG.read_text()
    main_config = json.loads(config)
    main_config["packages"]["platform"].pop("release-as", None)
    main_config = stable_line.dump_json(main_config)
    rules = [{
        "type": "required_status_checks", "ruleset_id": 10, "ruleset_source_type": "Repository",
        "parameters": {"do_not_enforce_on_create": False, "required_status_checks": REQUIRED},
    }]
    return {
        contents(".github/backport-targets.json", "main"): json.dumps({"branches": ["release/1.4"]}),
        contents(stable_line.DEPENDABOT_PATH, "main"): DEPENDABOT,
        api("releases/tags/platform-v1.5.0-rc.44"): {"draft": False, "prerelease": True},
        api("git/ref/tags/platform-v1.5.0-rc.44"): {"object": {"type": "tag", "sha": "tagobj"}},
        api("git/tags/tagobj"): {"object": {"type": "commit", "sha": "rc"}},
        api("compare/rc...main"): {"status": "ahead"},
        contents(".github/scripts/stable-line.py", "platform-v1.5.0-rc.44"): "# script\n",
        api("git/ref/tags/platform-v1.5.0"): NOT_FOUND,
        api("actions/variables/RELEASE_FREEZE"): {"value": "false"},
        pages("rulesets", "includes_parents=false"): [[{"id": 1}, {"id": 2}, {"id": 10}]],
        api("rulesets/1"): ruleset(1, ["refs/heads/main"], [{"type": "merge_queue", "parameters": QUEUE_PARAMS}]),
        api("rulesets/2"): ruleset(2, ["refs/heads/release/1.5"], [{"type": "merge_queue", "parameters": QUEUE_PARAMS}]),
        api("rulesets/10"): core_ruleset(),
        api("git/ref/heads/release/1.5"): NOT_FOUND,
        pages("commits/rc/check-runs"): [{"check_runs": [
            {"name": "Build", "conclusion": "success", "app": {"id": 15368}},
            # What main's commits carry: the release ruleset spells it without the hyphen.
            {"name": "Supply-Chain Policy", "conclusion": "success", "app": {"id": 15368}},
        ]}],
        pages("commits/rc/statuses"): [[]],
        pages("rules/branches/release%2F1.5"): [rules],
        contents(".github/release-please/.release-please-manifest.json", "main"): json.dumps({"platform": "1.5.0-rc.44"}),
        contents(".github/release-please/release-please-config.json", "main"): main_config,
        api("pulls?state=open&head=o%3Aautomation%2Frelease-as-1.6.0-rc.1&base=main"): [],
        api("labels/backport%20release%2F1.5"): NOT_FOUND,
        api("labels/backport%20release%2F1.4"): {"name": "backport release/1.4", "color": "0e8a16"},
        "POST " + api("labels"): {"name": "backport release/1.5"},
        contents("docs/pages/admin/upgrade-v1-4-to-v1-5.md", "main"): "---\ntitle: Upgrade\ndraft: true\n---\nbody\n",
        # What cut reads and writes after creating the branch.
        contents(".github/release-please/release-please-config.json", "release/1.5"): main_config,
        api("pulls?state=open&head=o%3Aautomation%2Fstable-cut-1.5&base=release%2F1.5"): [],
        api("git/commits/rc"): {"tree": {"sha": "rctree"}},
        "POST " + api("git/trees"): {"sha": "tree"},
        api("git/ref/heads/automation/stable-cut-1.5"): NOT_FOUND,
        "POST " + api("git/commits"): {"sha": "commit"},
        "POST " + api("pulls"): {"number": 7, "html_url": "https://example/7", "auto_merge": None},
        api("git/ref/heads/main"): {"object": {"sha": "mainsha"}},
        api("git/commits/mainsha"): {"tree": {"sha": "maintree"}},
        api("git/ref/heads/automation/release-as-1.6.0-rc.1"): NOT_FOUND,
    }


class FakeGitHub:
    def __init__(self, test, state):
        directory = tempfile.TemporaryDirectory()
        test.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "gh").write_text(FAKE_GH)
        (self.root / "gh").chmod(0o755)
        self.world = self.root / "world.json"
        self.world.write_text(json.dumps(state))
        self.log = self.root / "log.jsonl"
        self.log.touch()

    def run(self, *args):
        env = {
            **os.environ, "PATH": f"{self.root}{os.pathsep}{os.environ['PATH']}", "GH_REPO": REPO,
            "FAKE_GH_WORLD": str(self.world), "FAKE_GH_LOG": str(self.log),
        }
        return subprocess.run(["python3", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=30)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def writes(self):
        return [
            (call["args"][call["args"].index("--method") + 1], call["args"][1], call["body"])
            for call in self.calls() if "--method" in call["args"]
        ]

    def state(self):
        return json.loads(self.world.read_text())


class ConfigTest(unittest.TestCase):
    def test_stable_config_switches_the_track_and_pins_x_y_0(self):
        config = json.loads(stable_line.stable_config(CONFIG.read_text(), "1.5.0"))
        platform = config["packages"]["platform"]
        self.assertEqual(platform["versioning"], "always-bump-patch")
        self.assertIs(platform["prerelease"], False)
        self.assertNotIn("prerelease-type", platform)
        self.assertEqual(platform["release-as"], "1.5.0")
        self.assertIs(platform["draft"], True)

    def test_release_as_round_trips_the_file_byte_for_byte(self):
        config = json.loads(CONFIG.read_text())
        config["packages"]["platform"].pop("release-as", None)
        text = stable_line.dump_json(config)
        pinned = stable_line.release_as_config(text, "1.6.0-rc.1")
        self.assertEqual(stable_line.release_as(pinned), "1.6.0-rc.1")
        self.assertEqual(stable_line.without_release_as(pinned), text)

    def test_the_repository_config_is_written_the_way_it_is_read(self):
        text = CONFIG.read_text()
        self.assertEqual(stable_line.dump_json(json.loads(text)), text)

    def test_stable_config_refuses_to_drop_draft(self):
        config = json.loads(CONFIG.read_text())
        config["packages"]["platform"]["draft"] = False
        with self.assertRaises(stable_line.CutError):
            stable_line.stable_config(json.dumps(config), "1.5.0")


class RequiredChecksTest(unittest.TestCase):
    rule = {"parameters": {"required_status_checks": REQUIRED}}

    def test_name_and_app_must_both_match(self):
        runs = [
            {"name": "Build", "conclusion": "success", "app": {"id": 1}},
            {"name": "Supply Chain Policy", "conclusion": "skipped", "app": {"id": 15368}},
        ]
        self.assertEqual(stable_line.unmet_checks(self.rule, runs, []), ["Build"])

    def test_failed_runs_fail_and_commit_statuses_count(self):
        runs = [{"name": "Build", "conclusion": "failure", "app": {"id": 15368}}]
        statuses = [{"context": "Supply Chain Policy", "state": "success"}]
        self.assertEqual(stable_line.unmet_checks(self.rule, runs, statuses), ["Build"])

    def test_exemption_payload_drops_read_only_fields(self):
        payload = stable_line.exempt_creation(core_ruleset(), True)
        self.assertFalse(stable_line.RULESET_READ_ONLY & payload.keys())
        checks = next(rule for rule in payload["rules"] if rule["type"] == "required_status_checks")
        self.assertIs(checks["parameters"]["do_not_enforce_on_create"], True)
        self.assertEqual(checks["parameters"]["required_status_checks"], REQUIRED)


class PlanTest(unittest.TestCase):
    def test_plan_reads_only_and_reports_the_exemption_and_the_draft_guide(self):
        fake = FakeGitHub(self, world())
        result = fake.run("plan", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(fake.writes(), [])
        self.assertIn("[ ] create release/1.5 at platform-v1.5.0-rc.44", result.stdout)
        self.assertIn("has not passed Supply Chain Policy", result.stdout)
        self.assertIn("remove draft: true", result.stdout)

    def test_missing_queue_ruleset_blocks_with_the_infra_change(self):
        state = world()
        state[pages("rulesets", "includes_parents=false")] = [[{"id": 1}, {"id": 10}]]
        fake = FakeGitHub(self, state)
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 1)
        self.assertIn('add "1.5" to mergeQueue', result.stdout)
        self.assertEqual(fake.writes(), [])

    def test_blockers(self):
        cases = {
            "releases are frozen": (api("actions/variables/RELEASE_FREEZE"), {"value": "true"}),
            "is not a published prerelease": (api("releases/tags/platform-v1.5.0-rc.44"), {"draft": True, "prerelease": True}),
            "is not on main": (api("compare/rc...main"), {"status": "diverged"}),
            "already tagged": (api("git/ref/tags/platform-v1.5.0"), {"object": {"sha": "x"}}),
            "predates stable-line.py": (contents(".github/scripts/stable-line.py", "platform-v1.5.0-rc.44"), NOT_FOUND),
            "main already sets release-as 1.5.0-rc.45": (
                contents(".github/release-please/release-please-config.json", "main"),
                stable_line.release_as_config(CONFIG.read_text(), "1.5.0-rc.45"),
            ),
            "dependabot.yml on main: dependabot.yml has no release/1.4 entries to copy": (
                contents(stable_line.DEPENDABOT_PATH, "main"),
                DEPENDABOT.replace("target-branch: release/1.4", "target-branch: release/1.3"),
            ),
            "dependabot.yml on main: dependabot.yml already has release/1.5 entries": (
                contents(stable_line.DEPENDABOT_PATH, "main"),
                DEPENDABOT.replace("target-branch: release/1.4", "target-branch: release/1.5", 1),
            ),
        }
        for expected, (path, value) in cases.items():
            with self.subTest(expected):
                state = world()
                state[path] = value
                result = FakeGitHub(self, state).run("plan", "--rc-tag", "platform-v1.5.0-rc.44")
                self.assertEqual(result.returncode, 1)
                self.assertIn(expected, result.stdout)

    def test_a_left_over_creation_exemption_blocks(self):
        state = world()
        state[pages("rules/branches/release%2F1.5")][0][0]["parameters"]["do_not_enforce_on_create"] = True
        result = FakeGitHub(self, state).run("plan", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 1)
        self.assertIn("already skips required checks on branch creation", result.stdout)

    def test_only_a_newer_line_is_cut(self):
        for tag, expected in (("platform-v1.4.0-rc.56", "already the supported line"), ("platform-v1.3.0-rc.9", "older than")):
            with self.subTest(tag):
                result = FakeGitHub(self, world()).run("plan", "--rc-tag", tag)
                self.assertEqual(result.returncode, 1)
                self.assertIn(expected, result.stdout)


class CutTest(unittest.TestCase):
    def test_cut_exempts_creation_only_around_the_branch_then_opens_both_pull_requests(self):
        fake = FakeGitHub(self, world())
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        writes = fake.writes()
        flags = [
            next(r for r in body["rules"] if r["type"] == "required_status_checks")["parameters"]["do_not_enforce_on_create"]
            for method, path, body in writes if method == "PUT"
        ]
        self.assertEqual(flags, [True, False])
        order = [(method, path) for method, path, _ in writes]
        self.assertLess(order.index(("PUT", api("rulesets/10"))), order.index(("POST", api("git/refs"))))
        self.assertEqual(writes[1][2], {"ref": "refs/heads/release/1.5", "sha": "rc"})
        self.assertEqual(writes[2][0], "PUT")
        self.assertEqual(fake.state()[api("rulesets/10")]["rules"], core_ruleset()["rules"])

        [label] = [body for method, path, body in writes if path == api("labels")]
        self.assertEqual((label["name"], label["color"]), ("backport release/1.5", "0e8a16"))
        self.assertIn("do not merge main's open release PR", result.stdout)

        trees = [body for method, path, body in writes if path == api("git/trees")]
        stable, main = ({entry["path"]: entry["content"] for entry in tree["tree"]} for tree in trees)
        self.assertEqual(trees[0]["base_tree"], "rctree")
        self.assertEqual(json.loads(stable[stable_line.RELEASE_LINE_PATH]), {
            "line": "1.5", "previousLine": "1.4", "cutFrom": "platform-v1.5.0-rc.44",
        })
        self.assertEqual(stable_line.release_as(stable[stable_line.CONFIG_PATH]), "1.5.0")
        self.assertEqual(stable_line.release_as(main[stable_line.CONFIG_PATH]), "1.6.0-rc.1")
        dependabot = main[stable_line.DEPENDABOT_PATH]
        self.assertEqual(dependabot.count("target-branch: release/1.5"), DEPENDABOT.count("target-branch: release/1.4"))
        self.assertEqual(dependabot.count("target-branch: release/1.4"), DEPENDABOT.count("target-branch: release/1.4"))
        pulls = [body for method, path, body in writes if path == api("pulls")]
        self.assertEqual([(p["base"], p["head"]) for p in pulls], [
            ("release/1.5", "automation/stable-cut-1.5"), ("main", "automation/release-as-1.6.0-rc.1"),
        ])
        merges = [call["args"] for call in fake.calls() if call["args"][0] == "pr"]
        self.assertEqual(merges, [["pr", "merge", "7", "--repo", REPO, "--auto"]] * 2)

    def test_a_failed_branch_creation_still_restores_the_ruleset(self):
        state = world()
        state["POST " + api("git/refs")] = {"__status": 422, "message": "Repository rule violations"}
        fake = FakeGitHub(self, state)
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Repository rule violations", result.stderr)
        self.assertEqual(fake.state()[api("rulesets/10")]["rules"], core_ruleset()["rules"])
        self.assertEqual([m for m, _, _ in fake.writes()], ["PUT", "POST", "PUT"])

    def test_every_exempted_ruleset_is_restored_even_when_one_restore_fails(self):
        state = world()
        second = core_ruleset()
        second["id"] = 11
        state[api("rulesets/11")] = second
        state[pages("rulesets", "includes_parents=false")] = [[{"id": 1}, {"id": 2}, {"id": 10}, {"id": 11}]]
        rules = state[pages("rules/branches/release%2F1.5")][0]
        rules.append({**copy.deepcopy(rules[0]), "ruleset_id": 11})
        state["PUT " + api("rulesets/10")] = {"__seq": [core_ruleset(), {"__status": 502, "message": "Bad Gateway"}]}
        fake = FakeGitHub(self, state)
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 1)
        self.assertIn("rulesets did not restore: 10", result.stderr)
        self.assertIn("re-apply the infra Terraform", result.stderr)
        puts = [(path, body["rules"][1]["parameters"]["do_not_enforce_on_create"]) for m, path, body in fake.writes() if m == "PUT"]
        self.assertEqual(puts, [
            (api("rulesets/10"), True), (api("rulesets/11"), True),
            (api("rulesets/10"), False), (api("rulesets/11"), False),
        ])
        self.assertIs(fake.state()[api("rulesets/11")]["rules"][1]["parameters"]["do_not_enforce_on_create"], False)

    def test_cut_resumes_and_keeps_open_pull_requests(self):
        state = world()
        state[api("git/ref/heads/release/1.5")] = {"object": {"sha": "cutsha"}}
        state[api("compare/rc...release/1.5")] = {"status": "ahead"}
        state[contents(stable_line.RELEASE_LINE_PATH, "release/1.5")] = NOT_FOUND
        state[contents("docs/pages/admin/upgrade-v1-4-to-v1-5.md", "release/1.5")] = "---\ntitle: Upgrade\n---\n"
        self.open_cut_pulls(state)
        state[api("labels/backport%20release%2F1.5")] = {"name": "backport release/1.5"}
        fake = FakeGitHub(self, state)
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("[x] release/1.5 exists", result.stdout)
        self.assertIn("#9 is open", result.stdout)
        self.assertEqual(fake.writes(), [])
        self.assertEqual([call for call in fake.calls() if call["args"][0] == "pr"], [])

    def test_a_pull_request_with_other_changes_is_not_reused(self):
        state = world()
        state[api("git/ref/heads/release/1.5")] = {"object": {"sha": "cutsha"}}
        state[api("compare/rc...release/1.5")] = {"status": "ahead"}
        state[contents(stable_line.RELEASE_LINE_PATH, "release/1.5")] = NOT_FOUND
        state[contents("docs/pages/admin/upgrade-v1-4-to-v1-5.md", "release/1.5")] = "---\ntitle: Upgrade\n---\n"
        self.open_cut_pulls(state)
        state[pages("pulls/9/files")] = [[{"filename": stable_line.CONFIG_PATH}, {"filename": "platform/evil.sh"}]]
        fake = FakeGitHub(self, state)
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 1)
        self.assertIn("#9 from automation/stable-cut-1.5 is not the change this command makes", result.stderr)
        self.assertEqual([call for call in fake.calls() if call["args"][0] == "pr"], [])

    @staticmethod
    def open_cut_pulls(state):
        """Open the two pull requests cut would have opened, with exactly its changes."""
        main_config = state[contents(stable_line.CONFIG_PATH, "main")]
        expected = {
            9: ("automation%2Fstable-cut-1.5", "release%2F1.5", {
                stable_line.CONFIG_PATH: stable_line.stable_config(main_config, "1.5.0"),
                stable_line.RELEASE_LINE_PATH: stable_line.dump_json(
                    {"line": "1.5", "previousLine": "1.4", "cutFrom": "platform-v1.5.0-rc.44"}),
            }),
            12: ("automation%2Frelease-as-1.6.0-rc.1", "main", {
                stable_line.CONFIG_PATH: stable_line.release_as_config(main_config, "1.6.0-rc.1"),
                stable_line.DEPENDABOT_PATH: stable_line.set_release_line().add_line(
                    DEPENDABOT, "release/1.4", "release/1.5"),
            }),
        }
        for number, (head, base, files) in expected.items():
            state[api(f"pulls?state=open&head=o%3A{head}&base={base}")] = [{
                "number": number, "html_url": f"https://example/{number}",
                "auto_merge": {"merge_method": "squash"}, "head": {"sha": f"head{number}"},
            }]
            state[pages(f"pulls/{number}/files")] = [[{"filename": path} for path in files]]
            for path, text in files.items():
                state[contents(path, f"head{number}")] = text

    def test_an_unexpected_automation_branch_stops_the_cut(self):
        state = world()
        state[api("git/ref/heads/automation/stable-cut-1.5")] = {"object": {"sha": "other"}}
        state[api("git/commits/other")] = {"tree": {"sha": "othertree"}, "parents": [{"sha": "rc"}]}
        fake = FakeGitHub(self, state)
        result = fake.run("cut", "--rc-tag", "platform-v1.5.0-rc.44")
        self.assertEqual(result.returncode, 1)
        self.assertIn("automation/stable-cut-1.5 already exists with other changes", result.stderr)
        self.assertNotIn(api("pulls"), [path for _, path, _ in fake.writes()])


class FollowUpTest(unittest.TestCase):
    def notes_world(self, body="### Bug Fixes\n\n* fix"):
        return {
            contents(stable_line.RELEASE_LINE_PATH, "platform-v1.5.0"): json.dumps(
                {"line": "1.5", "previousLine": "1.4", "cutFrom": "platform-v1.5.0-rc.44"}),
            pages("releases"): [[
                {"id": 5, "tag_name": "platform-v1.5.0", "draft": True, "body": body, "html_url": "u"},
                {"id": 4, "tag_name": "platform-v1.5.0-rc.2", "draft": False, "html_url": "https://rc2"},
                {"id": 3, "tag_name": "platform-v1.5.0-rc.10", "draft": False, "html_url": "https://rc10"},
                # Published from main after the cut: not in 1.5.0.
                {"id": 8, "tag_name": "platform-v1.5.0-rc.45", "draft": False, "html_url": "https://rc45"},
                {"id": 2, "tag_name": "platform-v1.5.0-rc.11", "draft": True, "html_url": "https://rc11"},
                {"id": 1, "tag_name": "platform-v1.4.9", "draft": False, "html_url": "https://149"},
                {"id": 6, "tag_name": "platform-v1.4.12", "draft": False, "html_url": "https://1412"},
                # Tagged, but its draft was never published.
                {"id": 7, "tag_name": "platform-v1.4.13", "draft": True, "html_url": "https://1413"},
            ]],
        }

    def test_stable_notes_prepend_upgrade_context_once(self):
        fake = FakeGitHub(self, self.notes_world())
        result = fake.run("stable-notes", "--tag", "platform-v1.5.0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        [(method, path, body)] = fake.writes()
        self.assertEqual((method, path), ("PATCH", api("releases/5")))
        notes = body["body"]
        self.assertTrue(notes.startswith(stable_line.NOTES_MARKER))
        self.assertIn("https://archestra.ai/docs/v1.5/admin/upgrade-v1-4-to-v1-5", notes)
        self.assertIn("changes since `1.5.0-rc.44`", notes)
        self.assertIn("[rc.2](https://rc2) · [rc.10](https://rc10)", notes)
        self.assertNotIn("rc11", notes)
        self.assertNotIn("rc45", notes)
        self.assertIn(f"https://github.com/{REPO}/compare/platform-v1.4.12...platform-v1.5.0", notes)
        self.assertTrue(notes.endswith("### Bug Fixes\n\n* fix"))

        again = FakeGitHub(self, self.notes_world(notes))
        self.assertEqual(again.run("stable-notes", "--tag", "platform-v1.5.0").returncode, 0)
        self.assertEqual(again.writes(), [])

    def test_stable_notes_never_block_publication_on_the_body_limit(self):
        fake = FakeGitHub(self, self.notes_world("x" * stable_line.RELEASE_BODY_LIMIT))
        result = fake.run("stable-notes", "--tag", "platform-v1.5.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stdout)
        self.assertEqual(fake.writes(), [])

    def test_stable_notes_only_for_x_y_0(self):
        result = FakeGitHub(self, {}).run("stable-notes", "--tag", "platform-v1.5.1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a stable X.Y.0 tag", result.stderr)

    def test_clear_release_as_only_when_it_forced_the_published_version(self):
        config = contents(stable_line.CONFIG_PATH, "release/1.5")
        pinned = stable_line.stable_config(CONFIG.read_text(), "1.5.0")
        untouched = FakeGitHub(self, {config: pinned})
        result = untouched.run("clear-release-as", "--branch", "release/1.5", "--version", "1.5.1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing to clear", result.stdout)
        self.assertEqual(untouched.writes(), [])

        fake = FakeGitHub(self, {
            config: pinned,
            api("pulls?state=open&head=o%3Aautomation%2Fclear-release-as-1.5.0&base=release%2F1.5"): [],
            api("git/ref/heads/release/1.5"): {"object": {"sha": "head"}},
            api("git/commits/head"): {"tree": {"sha": "headtree"}},
            "POST " + api("git/trees"): {"sha": "tree"},
            api("git/ref/heads/automation/clear-release-as-1.5.0"): NOT_FOUND,
            "POST " + api("git/commits"): {"sha": "commit"},
            "POST " + api("pulls"): {"number": 8, "html_url": "https://example/8", "auto_merge": None},
        })
        result = fake.run("clear-release-as", "--branch", "release/1.5", "--version", "1.5.0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        [tree] = [body for _, path, body in fake.writes() if path == api("git/trees")]
        cleared = tree["tree"][0]["content"]
        self.assertIsNone(stable_line.release_as(cleared))
        self.assertEqual(json.loads(cleared)["packages"]["platform"]["versioning"], "always-bump-patch")


class HandoffTest(unittest.TestCase):
    def handoff_world(self, rulesets, runs=()):
        state = {
            contents(stable_line.RELEASE_LINE_PATH, "release/1.5"): json.dumps(
                {"line": "1.5", "previousLine": "1.4", "cutFrom": "platform-v1.5.0-rc.44"}),
            pages("pulls", "state=open&base=release%2F1.4"): [[{"number": 3, "title": "fix: x"}]],
            "POST " + api("issues/3/comments"): {},
            "PATCH " + api("pulls/3"): {},
            pages("rulesets", "includes_parents=false"): [[{"id": r["id"]} for r in rulesets]],
            pages("releases"): [[{"tag_name": "platform-v1.4.12", "draft": False}]],
            api("git/ref/tags/platform-v1.5.0-rc.44"): {"object": {"type": "commit", "sha": "rc"}},
            api("commits/rc"): {"commit": {"committer": {"date": "2026-11-20T00:00:00Z"}}},
            pages("pulls", "state=closed&base=release%2F1.4"): [[]],
            pages("pulls", "state=closed&base=release%2F1.5"): [[]],
        }
        for status in stable_line.ACTIVE_RUN_STATUSES:
            state[api(f"actions/workflows/release-please.yml/runs?branch=release%2F1.4&status={status}")] = {
                "workflow_runs": list(runs) if status == "waiting" else []}
        for r in rulesets:
            state[api(f"rulesets/{r['id']}")] = r
        return state

    def test_an_open_old_line_passes_and_keeps_its_pull_requests(self):
        queue = ruleset(2, ["refs/heads/release/1.4"], [{"type": "merge_queue", "parameters": QUEUE_PARAMS}])
        fake = FakeGitHub(self, self.handoff_world([queue]))
        result = fake.run("handoff", "--line", "1.5")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release/1.4 stays open. To lock it, move \"1.4\" from mergeQueue to readOnly", result.stdout)
        self.assertEqual(fake.writes(), [])

    def test_closes_old_pull_requests_once_the_line_is_read_only(self):
        # GitHub leaves out update_allows_fetch_and_merge at its default, false.
        for rule in ({"type": "update", "parameters": {"update_allows_fetch_and_merge": False}}, {"type": "update"}):
            with self.subTest(rule=rule):
                fake = FakeGitHub(self, self.handoff_world([ruleset(3, ["refs/heads/release/1.4"], [rule])]))
                result = fake.run("handoff", "--line", "1.5")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("release/1.4 is read-only", result.stdout)
                self.assertEqual([(m, p) for m, p, _ in fake.writes()], [
                    ("POST", api("issues/3/comments")), ("PATCH", api("pulls/3")),
                ])

    def test_a_bypassable_or_fetch_and_merge_rule_is_not_read_only(self):
        for bypass, params in (([{"actor_type": "OrganizationAdmin"}], {}), ([], {"update_allows_fetch_and_merge": True})):
            with self.subTest(bypass=bypass, params=params):
                eol = ruleset(3, ["refs/heads/release/1.4"], [{"type": "update", "parameters": params}], bypass)
                result = FakeGitHub(self, self.handoff_world([eol])).run("handoff", "--line", "1.5")
                self.assertEqual(result.returncode, 1)
                self.assertIn("has neither its merge queue nor a read-only ruleset", result.stderr)

    def test_waits_for_an_old_line_release_awaiting_publication(self):
        state = self.handoff_world([])
        state[pages("releases")] = [[{"tag_name": "platform-v1.4.13", "draft": True}, {"tag_name": "platform-v1.5.0", "draft": True}]]
        fake = FakeGitHub(self, state)
        result = fake.run("handoff", "--line", "1.5")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unpublished releases: platform-v1.4.13;", result.stderr)
        self.assertEqual(fake.writes(), [])

    def test_fixes_the_old_line_got_after_the_cut_must_be_on_the_new_line(self):
        def merged(number, head, at="2026-11-22T00:00:00Z"):
            return {"number": number, "title": f"fix {number}", "merged_at": at, "head": {"ref": head}}

        state = self.handoff_world([])
        state[pages("pulls", "state=closed&base=release%2F1.4")] = [[
            merged(20, "backport/release-1.4/pr-101"),  # source already in release/1.5's history
            merged(21, "backport/release-1.4/pr-102"),  # ported by its own release/1.5 backport
            merged(22, "backport/release-1.4/pr-103"),  # missing
            merged(23, "backport/release-1.4/pr-104", at="2026-11-19T00:00:00Z"),  # before the cut
            merged(24, "release-please--branches--release/1.4--components--platform"),
            merged(25, "dependabot/npm_and_yarn/x"),
            merged(26, "someone/manual-fix"),
            {"number": 27, "title": "closed", "merged_at": None, "head": {"ref": "backport/release-1.4/pr-105"}},
        ]]
        state[pages("pulls", "state=closed&base=release%2F1.5")] = [[merged(30, "backport/release-1.5/pr-102")]]
        state[api("pulls/101")] = {"merge_commit_sha": "s101"}
        state[api("pulls/102")] = {"merge_commit_sha": "s102"}
        state[api("pulls/103")] = {"merge_commit_sha": "s103"}
        state[api("compare/s101...release/1.5")] = {"status": "ahead"}
        state[api("compare/s103...release/1.5")] = {"status": "diverged"}
        fake = FakeGitHub(self, state)
        result = fake.run("handoff", "--line", "1.5")
        self.assertEqual(result.returncode, 1)
        self.assertIn("release/1.5 lacks fixes release/1.4 got after the cut: #103 (via #22);", result.stderr)
        self.assertIn("backport/release-1.5/pr-<main PR>", result.stderr)
        self.assertIn("check by hand that release/1.5 has #25 fix 25", result.stdout)
        self.assertIn("check by hand that release/1.5 has #26 fix 26", result.stdout)
        self.assertNotIn("#24", result.stdout)
        self.assertEqual(fake.writes(), [])

    def test_waits_for_old_line_release_runs(self):
        fake = FakeGitHub(self, self.handoff_world([], runs=[{"html_url": "https://run/1"}]))
        result = fake.run("handoff", "--line", "1.5")
        self.assertEqual(result.returncode, 1)
        self.assertIn("https://run/1", result.stderr)
        self.assertEqual(fake.writes(), [])


if __name__ == "__main__":
    unittest.main()
