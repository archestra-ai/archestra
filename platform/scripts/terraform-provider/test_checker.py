"""Exercise offline-spec verification through the checker CLI and real Make."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECKER = Path(__file__).resolve().parents[1] / 'check-terraform-provider.py'
MESSAGE = ('The provider revision does not read OPENAPI_SPEC in make codegen-api-client; '
           'choose a provider_ref with offline generation (provider v3 or later).')


class OfflineGenerationTests(unittest.TestCase):
    def run_checker(self, source_mode, failing=()):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            provider = root/'provider'
            (provider/'internal/provider').mkdir(parents=True)
            spec = root/'selected spec.json'
            spec.write_text('{"info":{"version":"selected"}}\n')
            bin_path = root/'bin'
            bin_path.mkdir()
            # Go is a process boundary here: these tests exercise input
            # provenance, independently of provider compilation and contracts.
            (bin_path/'go').write_text(
                '#!/bin/sh\nset -eu\necho go-was-run\n'
                'case "$4" in\n'
                '  ./internal/provider) test ! -e "$2/.codegen" ;;\n'
                '  ./...) test -f "$2/.codegen/openapi.raw.json" ;;\n'
                'esac\n' + ''.join(f'test "$4" != {target} || exit 1\n' for target in failing))
            (bin_path/'go').chmod(0o755)
            primary = 'cp "$$ARCHESTRA_OPENAPI_SPEC" .codegen/openapi.raw.json'
            credential = 'cp "$$ARCHESTRA_OPENAPI_SPEC" .codegen/credentials-source.json'
            if source_mode == 'ignore':
                primary = 'echo different-spec > .codegen/openapi.raw.json'
                credential = 'echo different-spec > .codegen/credentials-source.json'
            elif source_mode == 'credential-mismatch':
                credential = 'echo different-spec > .codegen/credentials-source.json'
            elif source_mode == 'missing':
                credential = 'true'
            elif source_mode == 'failed-fetch':
                credential = 'false'
            elif source_mode == 'primary-failure':
                primary += '\n\techo primary-generation-failed\n\tfalse'
            if source_mode == 'v3':
                primary = 'cp "$$OPENAPI_SPEC" .codegen/openapi.raw.json'
            (provider/'Makefile').write_text(
                'codegen-api-client:\n'
                '\ttest "$$ARCHESTRA_BASE_URL" = http://127.0.0.1:9\n'
                '\tmkdir -p .codegen\n\t'+primary+'\n' +
                ('' if source_mode == 'v3' else 'codegen-credential-client:\n\t'+credential+'\n'))
            return subprocess.run(
                [sys.executable, str(CHECKER), '--provider', str(provider), '--spec', str(spec)],
                env=os.environ | {'PATH': str(bin_path)+':'+os.environ['PATH']},
                text=True, capture_output=True,
            )

    def test_ignored_or_missing_selected_spec_exits_two_with_actionable_message(self):
        for mode in ('ignore', 'credential-mismatch', 'missing'):
            with self.subTest(mode=mode):
                result = self.run_checker(mode)
                self.assertEqual(result.returncode, 2, result.stdout+result.stderr)
                self.assertEqual(result.stderr.splitlines()[-1], MESSAGE)
                self.assertNotIn('All generated-client source SHA256 hashes match', result.stdout)
                self.assertNotIn('go-was-run', result.stdout)

    def test_generation_failure_after_selected_spec_exits_one(self):
        for mode in ('primary-failure', 'failed-fetch'):
            with self.subTest(mode=mode):
                result = self.run_checker(mode)
                self.assertEqual(result.returncode, 1, result.stdout+result.stderr)
                self.assertRegex(
                    result.stderr.splitlines()[-1],
                    r"^Client generation failed for the selected spec \(make exit [1-9]\d*\); "
                    r"the provider's codegen must handle this API change\.$",
                )
                self.assertNotIn(MESSAGE, result.stderr)
                self.assertNotIn('Compiling and running provider unit tests', result.stdout)
                if mode == 'primary-failure':
                    self.assertIn('primary-generation-failed', result.stdout)
                    self.assertNotIn('credentials-source.json', result.stdout)

    def test_v3_single_target_uses_openapi_spec(self):
        result = self.run_checker('v3')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('All generated-client source SHA256 hashes match', result.stdout)
        self.assertNotIn('credentials-source.json', result.stdout)
        self.assertLess(result.stdout.index('All generated-client'), result.stdout.index('go-was-run'))

    def test_failures_say_where_to_fix_them(self):
        contracts = 'Fix them on terraform-provider-archestra main.'
        unit_tests = 'fix the provider code there.'
        for failing, shown, hidden in ((('./internal/provider',), contracts, unit_tests),
                                       (('./...',), unit_tests, contracts)):
            with self.subTest(failing=failing):
                result = self.run_checker('v3', failing)
                self.assertEqual(result.returncode, 1, result.stdout+result.stderr)
                self.assertIn(shown, result.stderr)
                self.assertNotIn(hidden, result.stderr)
                self.assertEqual(result.stderr.splitlines()[-1],
                                 'The check runs against provider main, so the failure can predate this pull request.')

    def test_selected_spec_is_verified_before_compile(self):
        result = self.run_checker('honor')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('All generated-client source SHA256 hashes match the selected spec:', result.stdout)
        self.assertIn('Terraform provider request contracts and regenerated unit tests passed.', result.stdout)


if __name__ == '__main__':
    unittest.main()
