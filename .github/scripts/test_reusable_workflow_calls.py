"""Every call of a reusable workflow in this repository passes only the inputs
and secrets that workflow declares. GitHub rejects a caller that passes an
undeclared one ("Invalid secret", "Invalid input") when the run starts, so a
mismatch only shows on the event that runs the caller, such as a release."""
from pathlib import Path
import re
import unittest

WORKFLOWS = Path(__file__).parent.parent / "workflows"
LOCAL_CALL = re.compile(r"^    uses: [.$]/\.github/workflows/([\w.-]+\.ya?ml)\s*$")


def keys_under(lines, start, indent):
    """The keys at `indent` spaces in the block that starts after lines[start]."""
    keys = []
    for line in lines[start + 1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        depth = len(line) - len(line.lstrip(" "))
        if depth < indent:
            break
        if depth == indent:
            keys.append(line.strip().split(":", 1)[0])
    return keys


def declared(workflow):
    """The inputs and secrets of a workflow's `on.workflow_call`."""
    lines = (WORKFLOWS / workflow).read_text().splitlines()
    call = next(i for i, line in enumerate(lines) if line == "  workflow_call:")
    found = {"inputs": [], "secrets": []}
    for i in range(call + 1, len(lines)):
        line = lines[i]
        if line.strip() and len(line) - len(line.lstrip(" ")) < 4:
            break
        for kind in found:
            if line == f"    {kind}:":
                found[kind] = keys_under(lines, i, 6)
    return found


def calls():
    """(caller, job line, callee, passed inputs, passed secrets or "inherit")."""
    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        lines = path.read_text().splitlines()
        for number, line in enumerate(lines):
            match = LOCAL_CALL.match(line)
            if not match:
                continue
            start = number
            while start > 0 and not re.match(r"^  [\w-]+:\s*$", lines[start]):
                start -= 1
            end = number + 1
            while end < len(lines) and not re.match(r"^  [\w-]+:\s*$", lines[end]):
                end += 1
            inputs, secrets = [], []
            for i in range(start, end):
                if lines[i] == "    with:":
                    inputs = keys_under(lines, i, 6)
                elif lines[i] == "    secrets:":
                    secrets = keys_under(lines, i, 6)
                elif lines[i].strip() == "secrets: inherit":
                    secrets = "inherit"
            yield path.name, start + 1, match.group(1), inputs, secrets


class ReusableWorkflowCallTests(unittest.TestCase):
    def test_callers_pass_only_declared_inputs_and_secrets(self):
        checked = 0
        for caller, line, callee, inputs, secrets in calls():
            with self.subTest(caller=caller, line=line, callee=callee):
                interface = declared(callee)
                self.assertEqual(sorted(set(inputs) - set(interface["inputs"])), [],
                                 "inputs the called workflow does not declare")
                if secrets != "inherit":
                    self.assertEqual(sorted(set(secrets) - set(interface["secrets"])), [],
                                     "secrets the called workflow does not declare")
                checked += 1
        self.assertGreater(checked, 10)

    def test_the_parser_sees_a_declared_secret(self):
        self.assertIn("PLATFORM_NEXTJS_SOURCE_MAP_SENTRY_AUTH_TOKEN",
                      declared("build-native-multi-arch-image.yml")["secrets"])


if __name__ == "__main__":
    unittest.main()
