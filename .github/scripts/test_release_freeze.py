"""Exercise the release-freeze action Bash, stubbing only the GitHub CLI."""

import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ACTION = Path(__file__).resolve().parents[1] / "actions/release-freeze-review/action.yml"


class ReleaseFreezeTests(unittest.TestCase):
    def run_action(
        self,
        *,
        action="freeze",
        pr_number="",
        discovered="",
        discovery_status=0,
        review_states="",
    ):
        section = ACTION.read_text().split(
            "    - name: Find or validate release-please PRs and update reviews\n", 1
        )[1]
        script = textwrap.dedent(section.split("      run: |\n", 1)[1])
        stub = r'''
gh() {
  printf '%s\n' "$*" >> "$GH_CALLS"
  if [ "$1" = api ]; then
    for argument in "$@"; do
      case "$argument" in
        *"/pulls?state=open&per_page=100")
          printf '%s\n' "$DISCOVERED"
          return "$DISCOVERY_STATUS"
          ;;
        */reviews)
          response=NONE
          while IFS=: read -r number state; do
            case "$argument" in
              */pulls/"$number"/reviews) response=$state ;;
            esac
          done <<EOF
$REVIEW_STATES
EOF
          if [ "$response" = NONE ]; then
            printf 'null\n'
          else
            printf '{"state":"%s"}\n' "$response"
          fi
          return 0
          ;;
      esac
    done
  fi
}
'''
        with tempfile.TemporaryDirectory() as directory:
            calls = Path(directory) / "gh-calls"
            result = subprocess.run(
                ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stub + script],
                env={
                    **os.environ,
                    "GITHUB_REPOSITORY": "fixture/repo",
                    "GH_CALLS": str(calls),
                    "INPUT_ACTION": action,
                    "INPUT_PR_NUMBER": pr_number,
                    "DISCOVERED": discovered,
                    "DISCOVERY_STATUS": str(discovery_status),
                    "REVIEW_STATES": review_states,
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result, calls.read_text() if calls.exists() else ""

    def test_freeze_and_unfreeze_review_every_discovered_pr(self):
        for action, review_flag in (("freeze", "--request-changes"), ("unfreeze", "--approve")):
            with self.subTest(action=action):
                result, calls = self.run_action(action=action, discovered="101\n102")

                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("api --paginate repos/fixture/repo/pulls?state=open&per_page=100", calls)
                self.assertIn(f"pr review 101 {review_flag}", calls)
                self.assertIn(f"pr review 102 {review_flag}", calls)

    def test_discovery_paginates_and_partial_failure_blocks_reviews(self):
        result, calls = self.run_action(discovered="101", discovery_status=1)

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("api --paginate repos/fixture/repo/pulls?state=open&per_page=100", calls)
        self.assertNotIn("pr review", calls)
        self.assertIn("Cannot discover open release-please PRs", result.stdout)

    def test_explicit_pr_bypasses_discovery(self):
        result, calls = self.run_action(pr_number="55", discovery_status=1)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Using provided PR number: 55", result.stdout)
        self.assertNotIn("--paginate", calls)
        self.assertIn("pr review 55 --request-changes", calls)

    def test_no_matches_is_a_successful_noop(self):
        result, calls = self.run_action()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("No open release-please PR found.", result.stdout)
        self.assertNotIn("/reviews", calls)
        self.assertNotIn("pr review", calls)

    def test_already_desired_review_is_not_reposted(self):
        for action, state in (("freeze", "CHANGES_REQUESTED"), ("unfreeze", "APPROVED")):
            with self.subTest(action=action):
                result, calls = self.run_action(
                    action=action, pr_number="55", review_states=f"55:{state}"
                )

                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f"Skipping - already have {state} review", result.stdout)
                self.assertNotIn("pr review", calls)


if __name__ == "__main__":
    unittest.main()
