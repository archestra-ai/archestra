"""Execute workflow conditions to check privilege isolation and repair sequencing."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[3]


class WorkflowTests(unittest.TestCase):
    def test_only_trusted_main_events_publish(self):
        source = (ROOT / '.github/workflows/update-terraform-provider.yml').read_text()
        for job in ('prepare', 'publish'):
            job_source = source.split(f'  {job}:\n', 1)[1]
            condition = re.search(r'^    if: (.+)$', job_source, re.M)[1]
            for repository, ref, ready, expected in (
                ('archestra-ai/archestra', 'refs/heads/main', 'true', 'true'),
                ('archestra-ai/archestra', 'refs/heads/main', 'false', 'true' if job == 'prepare' else 'false'),
                ('archestra-ai/archestra', 'refs/heads/feature', 'true', 'false'),
                ('archestra-ai/archestra', 'refs/pull/12/merge', 'true', 'false'),
                ('archestra-ai/archestra', 'refs/heads/gh-readonly-queue/main/pr-12', 'true', 'false'),
                ('fork/archestra', 'refs/heads/main', 'true', 'false'),
            ):
                actual = subprocess.check_output(['node', '-e', '''
const vm = require('node:vm');
const [condition, repository, ref, ready] = process.argv.slice(1);
process.stdout.write(String(vm.runInNewContext(condition, {github:{repository, ref}, needs:{prepare:{outputs:{ready}}}})));
''', condition, repository, ref, ready], text=True)
                self.assertEqual(actual, expected)
        self.assertNotIn('secrets.', source.split('  publish:', 1)[0])
        self.assertNotIn('pull_request_target:', source)
        self.assertIn('ready: ${{ steps.generate.outputs.ready }}', source)
        self.assertIn('name: Generate and record test results\n        id: generate', source)

    def test_release_publication_starts_the_updater(self):
        release = (ROOT / '.github/workflows/release-please.yml').read_text()
        job = release.split('  update-terraform-provider:\n', 1)[1]
        job = re.split(r'^  [\w-]+:\n', job, maxsplit=1, flags=re.M)[0]
        self.assertRegex(job, r'needs:\n      - publish-github-release\n')
        self.assertRegex(job, r'permissions:\n      actions: write # .*\n    steps:')
        self.assertIn('run: gh workflow run update-terraform-provider.yml --ref main\n', job)
        self.assertNotIn('secrets.', job)
        condition = re.search(r'^    if: \$\{\{ (.+) \}\}$', job, re.M)[1]
        for ref, result, expected in (
            ('refs/heads/main', 'success', 'true'),
            ('refs/heads/main', 'skipped', 'false'),
            ('refs/heads/main', 'failure', 'false'),
            ('refs/heads/release/1.4', 'success', 'false'),
        ):
            actual = subprocess.check_output(['node', '-e', '''
const vm = require('node:vm');
const [condition, ref, result] = process.argv.slice(1);
process.stdout.write(String(vm.runInNewContext(condition, {github:{ref}, needs:{'publish-github-release':{result}}})));
''', condition.replace("needs.publish-github-release", "needs['publish-github-release']"), ref, result], text=True)
            self.assertEqual(actual, expected, (ref, result))
        updater = (ROOT / '.github/workflows/update-terraform-provider.yml').read_text()
        triggers = updater.split('\non:\n', 1)[1].split('\npermissions:', 1)[0]
        self.assertIn('  workflow_dispatch:\n', triggers)
        self.assertIn('  schedule:\n', triggers)
        self.assertNotIn('docs/openapi.json', triggers)

    def test_semantic_failure_is_reported_after_publication(self):
        source = (ROOT / '.github/workflows/update-terraform-provider.yml').read_text()
        self.assertLess(source.index('update_provider.py publish'), source.index('Report provider validation outcome'))

    def test_updater_generates_from_the_release_tag_spec(self):
        script = step_script('update-terraform-provider.yml', 'Read the released platform spec')
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            upstream = root/'upstream'
            git = ['git', '-C', str(upstream), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
            (upstream/'docs').mkdir(parents=True)
            subprocess.run(['git', 'init', '-q', str(upstream)], check=True)
            released = '{"info": {"version": "1.2.3-rc.4"}, "paths": "released"}\n'
            (upstream/'docs/openapi.json').write_text(released)
            subprocess.run([*git, 'add', '.'], check=True)
            subprocess.run([*git, 'commit', '-qm', 'release'], check=True)
            subprocess.run([*git, 'tag', '-a', 'platform-v1.2.3-rc.4', '-m', 'release'], check=True)
            release = subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip()
            # main changes the API before the next release; the version stays.
            (upstream/'docs/openapi.json').write_text('{"info": {"version": "1.2.3-rc.4"}, "paths": "main"}\n')
            subprocess.run([*git, 'commit', '-qam', 'main'], check=True)
            checkout = root/'checkout'
            subprocess.run(['git', 'clone', '-q', '--depth=1', f'file://{upstream}', str(checkout)], check=True)
            # Stub gh: the release is published, a draft, or missing.
            bin_path = root/'bin'
            bin_path.mkdir()
            (bin_path/'gh').write_text('#!/bin/sh\n'
                                       'test "$*" = "release view platform-v1.2.3-rc.4 --repo archestra-ai/archestra '
                                       '--json isDraft --jq .isDraft | not" || exit 9\n'
                                       'case "$RELEASE" in\n'
                                       '  missing) echo "release not found" >&2; exit 1 ;;\n'
                                       '  broken) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;\n'
                                       'esac\necho "$RELEASE"\n')
            (bin_path/'gh').chmod(0o755)
            env = os.environ | {'RUNNER_TEMP': work, 'GITHUB_OUTPUT': str(root/'output'),
                                'GITHUB_STEP_SUMMARY': str(root/'summary'), 'GH_TOKEN': 'unused',
                                'GITHUB_REPOSITORY': 'archestra-ai/archestra',
                                'PATH': f"{bin_path}:{os.environ['PATH']}"}
            for state in ('false', 'missing'):
                result = subprocess.run(['bash', '-c', script], cwd=checkout, capture_output=True, text=True,
                                        env=env | {'RELEASE': state})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('is not a published release yet', result.stdout)
                self.assertIn('skipped', json.loads((checkout/'provider-update/result.json').read_text()))
                self.assertFalse((root/'output').exists())
                self.assertFalse((root/'openapi-release.json').exists())
            result = subprocess.run(['bash', '-c', script], cwd=checkout, capture_output=True, text=True,
                                    env=env | {'RELEASE': 'broken'})
            self.assertEqual(result.returncode, 1)
            self.assertIn('::error::Could not read release platform-v1.2.3-rc.4: HTTP 401: Bad credentials', result.stdout)
            self.assertFalse((root/'output').exists())
            subprocess.run(['bash', '-c', script], cwd=checkout, check=True, capture_output=True,
                           env=env | {'RELEASE': 'true'})
            self.assertEqual((root/'openapi-release.json').read_text(), released)
            self.assertIn(f'commit={release}\n', (root/'output').read_text())
            self.assertIn('platform-v1.2.3-rc.4', (root/'summary').read_text())
            (checkout/'docs/openapi.json').write_text('{"info": {"version": "1.2.3; touch injected"}}\n')
            result = subprocess.run(['bash', '-c', script], cwd=checkout, capture_output=True, text=True,
                                    env=env | {'RELEASE': 'true'})
            self.assertEqual(result.returncode, 1)
            self.assertIn('does not name a platform release', result.stdout)
            self.assertFalse((checkout/'injected').exists())


def step_script(workflow, name):
    source = (ROOT / '.github/workflows' / workflow).read_text()
    step = source.split(f'      - name: {name}\n', 1)[1].split('\n      - name:', 1)[0]
    return textwrap.dedent(step.split('        run: |\n', 1)[1])


if __name__ == '__main__':
    unittest.main()
