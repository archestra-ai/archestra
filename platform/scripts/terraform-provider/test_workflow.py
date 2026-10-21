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

    def test_semantic_failure_is_reported_after_publication(self):
        source = (ROOT / '.github/workflows/update-terraform-provider.yml').read_text()
        self.assertLess(source.index('update_provider.py publish'), source.index('Report provider validation outcome'))
        check = (ROOT / '.github/workflows/on-pull-requests.yml').read_text()
        aggregate = re.split(r'^  [\w-]+:', check.split('  platform-lint-and-unit-tests:', 1)[1], maxsplit=1, flags=re.M)[0]
        self.assertNotIn('needs: terraform-provider-compatibility', aggregate)
        self.assertNotIn('terraform-provider-compatibility', check)
        compatibility = (ROOT / '.github/workflows/terraform-provider-compatibility.yml').read_text()
        self.assertNotIn('continue-on-error', compatibility)

    def test_compatibility_is_path_filtered_manual_and_unprivileged(self):
        source = (ROOT / '.github/workflows/terraform-provider-compatibility.yml').read_text()
        triggers = source.split('on:\n', 1)[1].split('\npermissions:', 1)[0]
        pr = triggers.split('  pull_request:\n', 1)[1].split('  workflow_dispatch:', 1)[0]
        self.assertRegex(pr, r'types: \[opened, synchronize, reopened\]')
        for name in ('docs/openapi.json', 'platform/scripts/check-terraform-provider.py',
                     'platform/scripts/terraform-provider/**',
                     '.github/workflows/terraform-provider-compatibility.yml',
                     '.github/workflows/update-terraform-provider.yml',
                     '.github/workflows/on-pull-requests.yml'):
            self.assertIn('- '+name, pr)
        self.assertNotIn('merge_group:', triggers)
        for name in ('platform_ref', 'provider_ref'):
            field = re.split(r'^      \w+:', triggers.split(f'      {name}:\n', 1)[1], maxsplit=1, flags=re.M)[0]
            for required in ('type: string', 'required: true', 'default: main'):
                self.assertIn(required, field)
        self.assertIn('\npermissions: {}', source)
        self.assertIn('    permissions:\n      contents: read', source)
        self.assertNotIn('secrets.', source)
        self.assertNotIn('continue-on-error', source)
        self.assertNotIn('persist-credentials: true', source)
        self.assertEqual(source.count('persist-credentials: false'), 2)
        self.assertNotIn('ref: ${{ inputs.platform_ref', source)
        self.assertIn('cancel-in-progress: true', source)
        self.assertIn('github.event.pull_request.number || github.run_id', source)
        checkout = source.split('      - name: Checkout platform\n', 1)[1].split('      - name:', 1)[0]
        self.assertNotIn('ref:', checkout)
        for step in re.split(r'^      - ', source, flags=re.M)[1:]:
            run = re.search(r'^        run: (.*)', step, re.M)
            if run:
                script = step[run.start():]
                self.assertNotIn('${{ inputs.', script)

    def test_dispatch_spec_path_is_passed_without_shell_interpolation(self):
        source = (ROOT / '.github/workflows/terraform-provider-compatibility.yml').read_text()
        step = source.split('      - name: Check provider request contracts and regenerated unit tests\n', 1)[1]
        command = re.search(r'^        run: (.*)$', step, re.M)[1]
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root/'scripts').mkdir()
            (root/'scripts/check-terraform-provider.py').write_text(
                'import json,sys; print(json.dumps(sys.argv[1:]))\n')
            # Execute the actual workflow command with an opaque path; shell syntax
            # inside an input must remain data, even for a path containing spaces.
            spec_path = '../old spec/$(touch injected)/openapi.json'
            result = subprocess.check_output(['bash', '-euc', command], cwd=root,
                env=os.environ | {'SPEC_FILE': spec_path}, text=True)
            self.assertEqual(json.loads(result), ['--provider', '../terraform-provider', '--spec', spec_path])
            self.assertFalse((root/'injected').exists())

    def test_platform_ref_is_validated_and_only_the_spec_is_read(self):
        script = compatibility_step_script('Read selected platform spec')
        self.assertIn('git show FETCH_HEAD:docs/openapi.json', script)
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root/'platform').mkdir()
            (root/'docs').mkdir()
            (root/'docs/openapi.json').write_text('{"openapi": "3.0.0"}\n')
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            env = os.environ | {'RUNNER_TEMP': work, 'GITHUB_OUTPUT': str(root/'output'),
                                'GITHUB_STEP_SUMMARY': str(root/'summary'), 'GH_TOKEN': 'unused'}
            for ref in ('', '--upload-pack=touch injected', 'main;touch injected', 'main\nother', '../../main'):
                result = subprocess.run(['bash', '-c', script], cwd=root/'platform', capture_output=True, text=True,
                                        env=env | {'EVENT_NAME': 'workflow_dispatch', 'PLATFORM_REF': ref})
                self.assertEqual(result.returncode, 2, ref)
                self.assertIn('platform_ref must be a branch, tag or commit SHA', result.stdout)
            self.assertFalse((root/'platform/injected').exists())
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
                            'commit', '-qm', 'spec'], check=True)
            subprocess.run(['bash', '-c', script], cwd=root/'platform', check=True,
                           env=env | {'EVENT_NAME': 'pull_request', 'PLATFORM_REF': ''})
            self.assertEqual((Path(work)/'openapi.json').read_text(), '{"openapi": "3.0.0"}\n')
            self.assertIn(f'file={work}/openapi.json', (root/'output').read_text())

    def test_provider_revision_must_be_on_a_branch_or_tag(self):
        script = compatibility_step_script('Check provider revision')
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root/'platform').mkdir()
            provider = root/'terraform-provider'
            git = ['git', '-C', str(provider), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
            subprocess.run(['git', 'init', '-q', str(provider)], check=True)
            subprocess.run([*git, 'commit', '-q', '--allow-empty', '-m', 'main'], check=True)
            main = subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip()
            subprocess.run([*git, 'update-ref', 'refs/remotes/origin/main', main], check=True)
            # A fork pull request commit is fetched by SHA without any branch or tag.
            fork = subprocess.check_output([*git, 'commit-tree', f'{main}^{{tree}}', '-p', main, '-m', 'fork'],
                                           text=True).strip()
            env = os.environ | {'GITHUB_STEP_SUMMARY': str(root/'summary')}
            for head, expected in ((main, 0), (fork, 2)):
                subprocess.run([*git, 'checkout', '-q', '--detach', head], check=True)
                result = subprocess.run(['bash', '-c', script], cwd=root/'platform', capture_output=True, text=True, env=env)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            self.assertIn(f'Provider commit: {main}', (root/'summary').read_text())

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
                                       'test "$RELEASE" != missing || exit 1\necho "$RELEASE"\n')
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


def compatibility_step_script(name):
    return step_script('terraform-provider-compatibility.yml', name)


if __name__ == '__main__':
    unittest.main()
