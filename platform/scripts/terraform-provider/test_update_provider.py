"""Local bare-Git + stub-gh integration tests; never accesses GitHub."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('update_provider.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        self.cmd('git', 'init', '--bare', '--initial-branch=main', str(self.remote))
        self.seed = self.clone('seed')
        for file, content in {
            updater.CLIENTS[0]: 'original client\n', updater.CLIENTS[1]: 'original bridge\n',
            'Makefile': 'codegen-api-client:\n\ttrue\ncodegen-credential-client:\n\ttrue\n',
            'platform-version.txt': '1.0.0\n', 'internal/provider/resource.go': 'original resource\n',
        }.items():
            target = self.seed / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        self.commit(self.seed, 'baseline')
        updater.git(self.seed, 'push', 'origin', 'main')
        self.spec = self.root / 'openapi.json'
        self.spec.write_text('{"info":{"version":"1.0.0"}}')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'go').write_text('#!/bin/sh\necho "representative semantic compile failure"\nexit 1\n')
        (self.bin / 'gh').write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['STUB_GH_ROOT'])
a = sys.argv[1:]
with (root/'gh.log').open('a') as log: log.write(json.dumps(a)+'\\n')
if a[:2] == ['pr', 'list']:
 print('7' if (root/'pr').exists() else '')
elif a[:2] == ['pr', 'create']:
 if os.environ.get('STUB_FAIL_CREATE') == '1': sys.exit(1)
 (root/'pr').write_text(Path(a[a.index('--body-file')+1]).read_text())
elif a[:1] == ['api'] and '--paginate' in a: print('[]')
''')
        for file in self.bin.iterdir(): file.chmod(0o755)
        self.env = patch.dict(os.environ, {'PATH': str(self.bin) + ':' + os.environ['PATH'], 'STUB_GH_ROOT': str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.counter = 0

    def cmd(self, *args):
        return subprocess.run(args, check=True, text=True, capture_output=True)

    def clone(self, name):
        repo = self.root / name
        self.cmd('git', 'clone', str(self.remote), str(repo))
        updater.git(repo, 'config', 'user.name', 'Test Maintainer')
        updater.git(repo, 'config', 'user.email', 'maintainer@example.invalid')
        return repo

    def commit(self, repo, message):
        updater.git(repo, 'add', '.')
        updater.git(repo, 'commit', '-m', message)
        return updater.git(repo, 'rev-parse', 'HEAD').stdout.strip()

    def prepare(self, change=True, generated_client="new generated client\n", tools=None):
        self.counter += 1
        candidate = self.clone(f'candidate-{self.counter}')
        out = self.root / f'artifact-{self.counter}'
        args = SimpleNamespace(provider=candidate, tools=tools or self.seed, spec=self.spec,
                               output=out, platform_commit='a'*40)
        def generate(tools, repo, spec):
            if change:
                (repo/updater.CLIENTS[0]).write_text(generated_client)
                if len(updater.clients((tools/'Makefile').read_text())) > 1:
                    (repo/updater.CLIENTS[1]).write_text('new generated bridge\n')
        with patch.object(updater, 'generate', side_effect=generate) as generator:
            updater.prepare(args)
        self.generation_calls = generator.call_count
        return out

    def publish(self, out):
        self.counter += 1
        repo = self.clone(f'publisher-{self.counter}')
        updater.publish(SimpleNamespace(provider=repo, output=out, run_url='https://example.invalid/run/1'))

    def use_v3_layout(self):
        (self.seed/'Makefile').write_text('codegen-api-client:\n\ttrue\n')
        (self.seed/updater.CLIENTS[1]).unlink()
        self.commit(self.seed, 'adopt single generated client')
        updater.git(self.seed, 'push', 'origin', 'main')

    def test_v3_publishes_single_client_without_bridge(self):
        self.use_v3_layout()
        out = self.prepare()
        self.publish(out)
        self.assertTrue((self.root/'pr').exists())
        check = self.clone('verify-v3')
        updater.git(check, 'checkout', updater.BRANCH)
        self.assertEqual((check/updater.CLIENTS[0]).read_text(), 'new generated client\n')
        self.assertFalse((check/updater.CLIENTS[1]).exists())

    def test_v3_rejects_bridge_even_when_repair_branch_declares_target(self):
        self.use_v3_layout()
        self.publish(self.prepare())
        human = self.clone('human-layout')
        updater.git(human, 'checkout', updater.BRANCH)
        (human/'Makefile').write_text('codegen-credential-client:\n\tfalse\n')
        self.commit(human, 'human tooling change')
        updater.git(human, 'push', 'origin', updater.BRANCH)
        out = self.prepare(generated_client='next client\n')
        candidate = self.root / f'candidate-{self.counter}'
        (candidate/updater.CLIENTS[1]).write_text('forbidden bridge\n')
        updater.git(candidate, 'add', updater.CLIENTS[1])
        (out/'update.patch').write_bytes(subprocess.check_output(
            ['git', '-C', str(candidate), 'diff', '--cached', '--binary', 'HEAD']))
        with self.assertRaisesRegex(ValueError, 'forbidden path'):
            self.publish(out)

    def test_missing_shared_target_explains_required_provider_change(self):
        self.use_v3_layout()
        (self.seed/'platform-version.txt').unlink()
        self.commit(self.seed, 'provider before shared target follow-up')
        updater.git(self.seed, 'push', 'origin', 'main')
        with self.assertRaisesRegex(ValueError, 'Provider main needs a change adding platform-version.txt'):
            self.prepare()
        self.assertFalse((self.root/'gh.log').exists())

    def test_failing_compile_still_creates_pr_and_rerun_reuses_it(self):
        out = self.prepare()
        self.assertEqual(json.loads((out/'result.json').read_text())['test_exit'], 1)
        self.assertTrue((out/'update.patch').stat().st_size)
        self.publish(out)
        self.assertIn('FAILED (exit 1)', (self.root/'pr').read_text())
        self.publish(self.prepare())
        calls = [json.loads(line) for line in (self.root/'gh.log').read_text().splitlines()]
        self.assertEqual(sum(call[:2] == ['pr', 'create'] for call in calls), 1)
        self.assertTrue(any(call[:1] == ['api'] and 'POST' in call for call in calls))

    def test_no_delta_does_not_create_commit_branch_or_pr(self):
        out = self.prepare(change=False)
        self.assertEqual((out/'update.patch').stat().st_size, 0)
        self.publish(out)
        self.assertFalse((self.root/'gh.log').exists())
        self.assertEqual(updater.git(self.seed, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout, '')

    def test_human_resource_commit_survives_next_generated_update(self):
        self.publish(self.prepare())
        human = self.clone('human')
        updater.git(human, 'checkout', updater.BRANCH)
        (human/'internal/provider/resource.go').write_text('human semantic fix\n')
        commit = self.commit(human, 'fix: adapt resource semantics')
        updater.git(human, 'push', 'origin', updater.BRANCH)
        self.spec.write_text('{"info":{"version":"1.1.0"}}')
        self.publish(self.prepare())
        check = self.clone('verify-human')
        updater.git(check, 'checkout', updater.BRANCH)
        updater.git(check, 'merge-base', '--is-ancestor', commit, 'HEAD')
        self.assertEqual((check/'internal/provider/resource.go').read_text(), 'human semantic fix\n')

    def test_generated_human_fix_preserved_on_rerun_and_conflict_on_new_target(self):
        self.publish(self.prepare())
        human = self.clone('human')
        updater.git(human, 'checkout', updater.BRANCH)
        (human/updater.CLIENTS[0]).write_text('human generated-code fix\n')
        commit = self.commit(human, 'fix: generated code')
        updater.git(human, 'push', 'origin', updater.BRANCH)
        self.publish(self.prepare())
        self.assertEqual(self.generation_calls, 0)
        self.spec.write_text('{"info":{"version":"1.1.0"}}')
        with self.assertRaisesRegex(ValueError, 'Human changes'):
            self.prepare()
        head = updater.git(human, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout.split()[0]
        self.assertEqual(head, commit)

    def update_trusted_generator(self):
        (self.seed/'generator.txt').write_text('trusted generator repair\n')
        commit = self.commit(self.seed, 'fix: generator repair')
        updater.git(self.seed, 'push', 'origin', 'main')
        return commit

    def test_same_spec_with_new_trusted_generator_refreshes_client(self):
        self.publish(self.prepare())
        generator_commit = self.update_trusted_generator()
        out = self.prepare(generated_client='repaired generated client\n')
        self.assertEqual(self.generation_calls, 1)
        self.publish(out)
        check = self.clone('verify-generator')
        updater.git(check, 'checkout', updater.BRANCH)
        self.assertEqual((check/updater.CLIENTS[0]).read_text(), 'repaired generated client\n')
        self.assertEqual(json.loads((check/updater.MANIFEST).read_text())['generator_commit'], generator_commit)

    def test_generator_change_refuses_to_overwrite_human_generated_fix(self):
        self.publish(self.prepare())
        human = self.clone('human')
        updater.git(human, 'checkout', updater.BRANCH)
        (human/updater.CLIENTS[0]).write_text('human generated-code fix\n')
        commit = self.commit(human, 'fix: generated code')
        updater.git(human, 'push', 'origin', updater.BRANCH)
        self.update_trusted_generator()
        with self.assertRaisesRegex(ValueError, 'Human changes'):
            self.prepare()
        self.assertEqual(updater.git(human, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout.split()[0], commit)

    def test_mismatched_tools_revision_fails_before_generation_or_publication(self):
        stale_tools = self.clone('stale-tools')
        self.update_trusted_generator()
        with self.assertRaisesRegex(ValueError, 'revisions differ'):
            self.prepare(tools=stale_tools)
        self.assertFalse((self.root/'artifact-1/result.json').exists())
        self.assertFalse((self.root/'artifact-1/update.patch').exists())
        self.assertFalse((self.root/'gh.log').exists())
        self.assertEqual(updater.git(self.seed, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout, '')
        # A fresh matching pair can prepare and publish normally on retry.
        self.publish(self.prepare())
        self.assertTrue((self.root/'pr').exists())

    def test_recover_pushed_branch_after_pr_creation_failure(self):
        with patch.dict(os.environ, {'STUB_FAIL_CREATE': '1'}):
            with self.assertRaises(subprocess.CalledProcessError):
                self.publish(self.prepare())
        self.assertFalse((self.root/'pr').exists())
        self.publish(self.prepare())
        self.assertTrue((self.root/'pr').exists())

    def test_concurrent_human_push_blocks_stale_publication(self):
        self.publish(self.prepare())
        out = self.prepare()
        human = self.clone('human')
        updater.git(human, 'checkout', updater.BRANCH)
        (human/'internal/provider/resource.go').write_text('racing human fix\n')
        commit = self.commit(human, 'fix: concurrent update')
        updater.git(human, 'push', 'origin', updater.BRANCH)
        with self.assertRaisesRegex(ValueError, 'moved during generation'):
            self.publish(out)
        self.assertEqual(updater.git(human, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout.split()[0], commit)

    def test_publisher_rejects_paths_outside_generated_allowlist(self):
        out = self.prepare()
        candidate = self.root / 'candidate-1'
        (candidate/'unapproved.txt').write_text('must not publish')
        updater.git(candidate, 'add', 'unapproved.txt')
        patch_bytes = subprocess.check_output(['git', '-C', str(candidate), 'diff', '--cached', '--binary', 'HEAD'])
        (out/'update.patch').write_bytes(patch_bytes)
        with self.assertRaisesRegex(ValueError, 'forbidden path'):
            self.publish(out)
        self.assertEqual(updater.git(self.seed, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout, '')

    def test_main_merge_conflict_fails_without_remote_overwrite(self):
        self.publish(self.prepare())
        human = self.clone('human')
        updater.git(human, 'checkout', updater.BRANCH)
        (human/'internal/provider/resource.go').write_text('human semantic fix\n')
        commit = self.commit(human, 'fix: human')
        updater.git(human, 'push', 'origin', updater.BRANCH)
        (self.seed/'internal/provider/resource.go').write_text('main semantic fix\n')
        self.commit(self.seed, 'fix: main')
        updater.git(self.seed, 'push', 'origin', 'main')
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare()
        self.assertEqual(updater.git(human, 'ls-remote', '--heads', 'origin', 'refs/heads/'+updater.BRANCH).stdout.split()[0], commit)


class CanonicalGenerationTests(unittest.TestCase):
    def test_v3_canonical_pipeline_has_one_client(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            tools, candidate = root/'trusted', root/'candidate'
            tools.mkdir()
            (candidate/'internal/client').mkdir(parents=True)
            api = root/'spec.json'
            api.write_text('selected API input\n')
            (tools/'Makefile').write_text(
                'codegen-api-client:\n'
                '\tmkdir -p internal/client .codegen\n'
                '\tcp "$$OPENAPI_SPEC" .codegen/openapi.raw.json\n'
                '\tcp "$$OPENAPI_SPEC" internal/client/archestra_client.go\n')
            (candidate/'Makefile').write_text('codegen-credential-client:\n\tfalse\n')
            updater.generate(tools, candidate, api)
            self.assertEqual((candidate/updater.CLIENTS[0]).read_text(), api.read_text())
            self.assertFalse((candidate/updater.CLIENTS[1]).exists())

    def test_trusted_pipeline_changes_are_honored_without_running_repair_tooling(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            tools, candidate = root/'trusted', root/'candidate'
            tools.mkdir()
            (candidate/'internal/client').mkdir(parents=True)
            api = root/'exact spec.json'
            api.write_text('exact API input\n')
            (tools/'credential-operations.txt').write_text('original operation\n')
            (tools/'Makefile').write_text(
                'codegen-api-client:\n'
                '\ttest -z "$$GH_TOKEN$$GITHUB_TOKEN$$ARCHESTRA_API_KEY"\n'
                '\ttest "$$ARCHESTRA_BASE_URL" = http://127.0.0.1:9\n'
                '\tmkdir -p internal/client .codegen\n'
                '\tcp "$$ARCHESTRA_OPENAPI_SPEC" .codegen/openapi.raw.json\n'
                '\tcat "$$ARCHESTRA_OPENAPI_SPEC" > internal/client/archestra_client.go\n'
                'codegen-credential-client:\n'
                '\tcp "$$ARCHESTRA_OPENAPI_SPEC" .codegen/credentials-source.json\n'
                '\tcat credential-operations.txt "$$ARCHESTRA_OPENAPI_SPEC" > internal/client/archestra_client_manual.go\n')
            (candidate/'Makefile').write_text('codegen-api-client:\n\ttouch repair-tooling-was-executed\n')
            with patch.dict(os.environ, {key: 'must-not-reach-generator' for key in
                           ('GH_TOKEN', 'GITHUB_TOKEN', 'ARCHESTRA_API_KEY', 'ARCHESTRA_BASE_URL')}):
                updater.generate(tools, candidate, api)
                self.assertEqual((candidate/updater.CLIENTS[0]).read_text(), api.read_text())
                self.assertEqual((candidate/updater.CLIENTS[1]).read_text(), 'original operation\n'+api.read_text())
                (tools/'credential-operations.txt').write_text('new credential operation\n')
                updater.generate(tools, candidate, api)
            self.assertEqual((candidate/updater.CLIENTS[1]).read_text(), 'new credential operation\n'+api.read_text())
            self.assertFalse((candidate/'repair-tooling-was-executed').exists())
            self.assertFalse((tools/'internal/client').exists())


if __name__ == '__main__':
    unittest.main()
