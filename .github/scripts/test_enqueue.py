"""Exercise enqueue's safeguards with real Git and fake process boundaries."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BOUNDARY = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
from urllib.parse import quote
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
scenario = json.loads(pathlib.Path(os.environ['ARCHESTRA_TEST_ENQUEUE_SCENARIO']).read_text())
marker = pathlib.Path(os.environ['ARCHESTRA_TEST_ENQUEUE_CALLS'])
with marker.open('a') as out:
    out.write(json.dumps({'command': command, 'args': args, 'cwd': os.getcwd()}) + '\n')
calls = [json.loads(line) for line in marker.read_text().splitlines()]

def change(kind):
    if kind == 'head':
        subprocess.run(['git', 'commit', '--allow-empty', '-qm', 'concurrent change'], check=True)
    elif kind == 'dirty':
        pathlib.Path('new-source.ts').write_text('concurrent change')

def require(condition):
    if not condition:
        print('unsupported arguments: ' + repr(args), file=sys.stderr)
        sys.exit(64)

host, owner, name = scenario.get('repository', 'github.com/fixture/repository').split('/')
selector = '/'.join([host, owner, name])
if command == 'pnpm':
    require(args == ['preflight', scenario['head']])
    change(scenario.get('during_preflight'))
    sys.exit(23 if scenario.get('preflight_failure') else 0)
elif args[:2] == ['pr', 'view']:
    require(args == ['pr', 'view', '42', '--repo', selector, '--json',
                    'id,number,url,state,isDraft,headRefOid,baseRefName,mergeable'])
    count = sum(c['command'] == 'gh' and c['args'][:2] == ['pr', 'view'] for c in calls)
    pr = {'id': 'PR_fixture_42', 'number': 42, 'url': f'https://{host}/{owner}/{name}/pull/42',
          'state': 'OPEN', 'isDraft': False, 'headRefOid': scenario['head'],
          'baseRefName': scenario.get('base', 'main'), 'mergeable': 'MERGEABLE'}
    views = scenario.get('views', [{}])
    pr.update(views[min(count - 1, len(views) - 1)])
    if count == 2:
        change(scenario.get('during_refresh'))
    print(json.dumps(pr))
elif args[:2] == ['api', 'graphql']:
    require(args[2:4] == ['--hostname', host])
    query = next(a for a in args if a.startswith('query='))
    if 'enqueuePullRequest' in query:
        require('expectedHeadOid:$head' in query and 'pullRequestId:$id' in query)
        require(f'head={scenario["head"]}' in args and 'id=PR_fixture_42' in args)
        require('jump' not in query and 'enablePullRequestAutoMerge' not in query)
        if scenario.get('queue_failure'):
            print('GraphQL: Required checks have not passed or queue is unavailable', file=sys.stderr)
            sys.exit(23)
        print(json.dumps({'data': {'enqueuePullRequest': {'mergeQueueEntry': {'id': 'MQE_fixture'}}}}))
    else:
        require(f'owner={owner}' in args and f'name={name}' in args and 'number=42' in args)
        result = {'state': 'OPEN', 'headRefOid': scenario['head'],
                  'mergeQueueEntry': {'position': 2}}
        result.update(scenario.get('queue_result', {}))
        print(json.dumps({'data': {'repository': {'pullRequest': result}}}))
elif args[:1] == ['api']:
    base = quote(scenario.get('base', 'main'), safe='')
    require(args == ['api', '--hostname', host, f'repos/{owner}/{name}/rules/branches/{base}'])
    count = sum(c['command'] == 'gh' and c['args'][:1] == ['api'] and c['args'][1] != 'graphql' for c in calls)
    if count == scenario.get('rules_failure'):
        sys.exit(23)
    enabled = scenario.get('rules', [True])
    print(json.dumps([{'type': 'merge_queue'}] if enabled[min(count - 1, len(enabled) - 1)] else []))
else:
    require(False)
'''


class EnqueueTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / 'repo'
        self.platform = self.repo / 'platform'
        scripts = self.platform / 'scripts'
        scripts.mkdir(parents=True)
        shutil.copy(ROOT / 'platform/scripts/enqueue.mjs', scripts)
        self.git('init', '-q')
        self.git('config', 'user.name', 'CI')
        self.git('config', 'user.email', 'ci@example.test')
        self.git('remote', 'add', 'origin', 'git@github.com:fixture/repository.git')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        self.head = self.git('rev-parse', 'HEAD')
        self.scenario = self.root / 'scenario.json'
        self.marker = self.root / 'calls'
        binaries = self.root / 'bin'
        binaries.mkdir()
        for name in ('gh', 'pnpm'):
            path = binaries / name
            path.write_text(BOUNDARY)
            path.chmod(0o755)
        self.env = os.environ | {
            'PATH': f"{binaries}:{os.environ['PATH']}",
            'ARCHESTRA_TEST_ENQUEUE_SCENARIO': str(self.scenario),
            'ARCHESTRA_TEST_ENQUEUE_CALLS': str(self.marker),
            # An unrelated CLI default must not redirect our explicit target.
            'GH_REPO': 'unrelated/repository',
            'GH_HOST': 'unrelated.example.test',
        }

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, capture_output=True,
                              text=True, check=True).stdout.strip()

    def enqueue(self, *args, **scenario):
        self.marker.unlink(missing_ok=True)
        self.scenario.write_text(json.dumps({'head': self.head} | scenario))
        return subprocess.run(
            ['node', str(self.platform / 'scripts/enqueue.mjs'), *args],
            cwd=self.root, env=self.env, text=True, capture_output=True,
        )

    def calls(self, command=None):
        calls = [] if not self.marker.exists() else [json.loads(s) for s in self.marker.read_text().splitlines()]
        return [c for c in calls if command is None or c['command'] == command]

    def queue_requests(self):
        return [c for c in self.calls('gh') if any('enqueuePullRequest' in a for a in c['args'])]

    def assert_blocked(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.queue_requests(), [])

    def test_preflight_precedes_guarded_queue_request_for_exact_head(self):
        result = self.enqueue('42')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        preflight = self.calls('pnpm')
        self.assertEqual(len(preflight), 1)
        self.assertEqual(preflight[0]['args'], ['preflight', self.head])
        self.assertLess(calls.index(preflight[0]), calls.index(self.queue_requests()[0]))
        self.assertTrue(all(c['cwd'] == str(self.platform.resolve()) for c in calls))
        self.assertIn('Queued https://github.com/fixture/repository/pull/42', result.stdout)

    def test_origin_urls_and_explicit_upstream_keep_repository_and_host_explicit(self):
        for remote in ('https://github.com/fixture/repository.git',
                       'ssh://git@github.com/fixture/repository.git'):
            with self.subTest(remote=remote):
                self.git('remote', 'set-url', 'origin', remote)
                result = self.enqueue('42')
                self.assertEqual(result.returncode, 0, result.stderr)
        result = self.enqueue('42', '--repo', 'upstream/repository', repository='github.com/upstream/repository')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.enqueue('42', '--repo', 'git.example.test/upstream/repository',
                              repository='git.example.test/upstream/repository', base='release/1.3')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_arguments_never_contact_github(self):
        for args in ((), ('0',), ('--admin',), ('42', '--admin'), ('42', '--repo'),
                     ('42', '--repo', '../repository'), ('42', '--repo', 'a/b/c/d'),
                     ('42', '--repo', 'a/b', 'extra'), ('9007199254740992',)):
            with self.subTest(args=args):
                self.assert_blocked(self.enqueue(*args))
                self.assertEqual(self.calls(), [])
        result = self.enqueue('--help')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_unresolvable_origin_requires_explicit_repository(self):
        self.git('remote', 'set-url', 'origin', '/local/repository')
        self.assert_blocked(self.enqueue('42'))
        self.assertEqual(self.calls(), [])

    def test_dirty_checkout_blocks_before_github_or_preflight(self):
        for staged in (False, True):
            with self.subTest(staged=staged):
                source = self.platform / 'scripts/enqueue.mjs'
                original = source.read_text()
                source.write_text(original + '\n// modified\n')
                if staged:
                    self.git('add', '.')
                self.assert_blocked(self.enqueue('42'))
                self.assertEqual(self.calls(), [])
                self.git('restore', '--staged', '.')
                source.write_text(original)
        (self.repo / 'untracked.txt').write_text('untracked outside platform')
        self.assert_blocked(self.enqueue('42'))
        self.assertEqual(self.calls(), [])

    def test_wrong_pr_head_blocks_before_preflight(self):
        self.assert_blocked(self.enqueue('42', views=[{'headRefOid': '0' * 40}]))
        self.assertEqual(self.calls('pnpm'), [])

    def test_closed_draft_and_conflicting_prs_block_before_preflight(self):
        for state in ({'state': 'CLOSED'}, {'state': 'MERGED'}, {'isDraft': True}, {'mergeable': 'CONFLICTING'}):
            with self.subTest(state=state):
                self.assert_blocked(self.enqueue('42', views=[state]))
                self.assertEqual(self.calls('pnpm'), [])

    def test_preflight_failure_cannot_enqueue(self):
        self.assert_blocked(self.enqueue('42', preflight_failure=True))

    def test_changes_during_preflight_cannot_enqueue(self):
        for change in ('dirty', 'head'):
            with self.subTest(change=change):
                self.assert_blocked(self.enqueue('42', during_preflight=change))
                self.git('reset', '--hard', self.head)
                (self.platform / 'new-source.ts').unlink(missing_ok=True)

    def test_remote_head_base_or_eligibility_change_cannot_enqueue(self):
        for changed in ({'headRefOid': '0' * 40}, {'baseRefName': 'other'},
                        {'state': 'CLOSED'}, {'isDraft': True}):
            with self.subTest(changed=changed):
                self.assert_blocked(self.enqueue('42', views=[{}, changed]))

    def test_local_change_during_remote_refresh_cannot_enqueue(self):
        self.assert_blocked(self.enqueue('42', during_refresh='dirty'))

    def test_missing_removed_or_unreadable_queue_rule_cannot_merge_directly(self):
        for scenario in ({'rules': [False]}, {'rules': [True, False]},
                         {'rules_failure': 1}, {'rules_failure': 2}):
            with self.subTest(scenario=scenario):
                self.assert_blocked(self.enqueue('42', **scenario))

    def test_rejected_queue_request_cannot_fall_back_to_auto_merge(self):
        result = self.enqueue('42', queue_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.queue_requests()), 1)
        self.assertNotIn('Queued https:', result.stdout)
        self.assertFalse(any('enablePullRequestAutoMerge' in a for c in self.calls('gh') for a in c['args']))

    def test_wrong_pr_identity_is_rejected_before_preflight(self):
        self.assert_blocked(self.enqueue('42', views=[{'number': 43}]))
        self.assertEqual(self.calls('pnpm'), [])

    def test_confirmed_merged_state_is_reported_as_complete(self):
        result = self.enqueue('42', queue_result={'state': 'MERGED', 'mergeQueueEntry': None})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Merged https://github.com/fixture/repository/pull/42', result.stdout)

    def test_unconfirmed_or_changed_queue_result_does_not_claim_success(self):
        for changed in ({'mergeQueueEntry': None}, {'headRefOid': '0' * 40}):
            with self.subTest(changed=changed):
                result = self.enqueue('42', queue_result=changed)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.queue_requests()), 1)
                self.assertNotIn('Queued https:', result.stdout)
                self.assertIn('Inspect https:', result.stderr)


if __name__ == '__main__':
    unittest.main()
