"""Render the real chart to catch warnings that break mirrors or miss old overrides."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

CHART = Path(__file__).resolve().parents[2] / 'platform/helm/archestra'


@unittest.skipUnless(shutil.which('helm'), 'Helm is required to render chart notes')
class RegistryNoticeTests(unittest.TestCase):
    def render(self, *values):
        options = ['--set', 'postgresql.auth.password=test',
                   '--set', 'postgresql.auth.postgresPassword=test']
        for value in values:
            options.extend(['--set-string', value])

        def render(chart):
            result = subprocess.run(['helm', 'template', 'migration-notice', str(chart), *options],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

        resources = render(CHART)
        # Helm 3's install dry-run still checks cluster reachability, and Helm
        # template excludes NOTES.txt. Render the actual notes with tpl inside
        # an isolated chart so these tests require neither a cluster nor login.
        with tempfile.TemporaryDirectory() as directory:
            chart = Path(directory)
            (chart / 'templates').mkdir()
            (chart / 'Chart.yaml').write_text('apiVersion: v2\nname: registry-notice\nversion: 0.0.0\n')
            shutil.copyfile(CHART / 'values.yaml', chart / 'values.yaml')
            shutil.copyfile(CHART / 'templates/_helpers.tpl', chart / 'templates/_helpers.tpl')
            shutil.copyfile(CHART / 'templates/NOTES.txt', chart / 'registry-notice.txt')
            (chart / 'templates/notice.yaml').write_text(
                'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notice\ndata:\n  notes: |\n'
                '{{ tpl (.Files.Get "registry-notice.txt") . | indent 4 }}\n')
            return resources + render(chart)

    def test_defaults_and_internal_mirrors_do_not_warn_or_get_rewritten(self):
        self.assertNotIn('Registry migration notice:', self.render())
        rendered = self.render('archestra.image=registry.example/team/platform:custom',
                               'archestra.env.ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY=registry.example/team')
        self.assertNotIn('Registry migration notice:', rendered)
        self.assertIn('registry.example/team/platform:custom', rendered)
        self.assertIn('registry.example/team', rendered)

    def test_platform_dockerhub_overrides_remain_supported(self):
        for image in ('archestra/platform', 'docker.io/archestra/platform:1.4.0'):
            self.assertNotIn('Registry migration notice:', self.render('archestra.image=' + image))

    def test_old_companion_overrides_are_named(self):
        for variable in ('ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY',
                         'ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE',
                         'ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_SHIM_IMAGE'):
            with self.subTest(variable=variable):
                rendered = self.render('archestra.env.' + variable + '=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public')
                self.assertIn('  - archestra.env.' + variable, rendered)
