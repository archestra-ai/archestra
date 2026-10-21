"""Execute workflow conditions to check privilege isolation and repair sequencing."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
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
        self.assertEqual(source.count('persist-credentials: false'), 3)
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


if __name__ == '__main__':
    unittest.main()
