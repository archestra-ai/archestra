"""Render the real chart to catch warnings that break mirrors or miss old overrides."""
import shutil
import subprocess
import unittest
from pathlib import Path

CHART = Path(__file__).resolve().parents[2] / 'platform/helm/archestra'


@unittest.skipUnless(shutil.which('helm'), 'Helm is required to render chart notes')
class RegistryNoticeTests(unittest.TestCase):
    def render(self, *values):
        command = ['helm', 'install', 'migration-notice', str(CHART), '--dry-run=client',
                   '--set', 'postgresql.auth.password=test',
                   '--set', 'postgresql.auth.postgresPassword=test']
        for value in values:
            command.extend(['--set-string', value])
        return subprocess.check_output(command, text=True, stderr=subprocess.PIPE)

    def test_defaults_and_internal_mirrors_do_not_warn_or_get_rewritten(self):
        self.assertNotIn('Registry migration notice:', self.render())
        rendered = self.render('archestra.image=registry.example/team/platform:custom',
                               'archestra.env.ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY=registry.example/team')
        self.assertNotIn('Registry migration notice:', rendered)
        self.assertIn('registry.example/team/platform:custom', rendered)
        self.assertIn('registry.example/team', rendered)

    def test_old_public_platform_and_companion_overrides_are_named(self):
        for image in ('archestra/platform', 'docker.io/archestra/platform:1.4.0',
                      'europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/platform:pinned'):
            with self.subTest(image=image):
                rendered = self.render('archestra.image=' + image)
                self.assertIn('Registry migration notice:', rendered)
                self.assertIn('  - archestra.image', rendered)
                self.assertIn(image, rendered)
        for variable in ('ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY',
                         'ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE',
                         'ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_SHIM_IMAGE'):
            with self.subTest(variable=variable):
                rendered = self.render('archestra.env.' + variable + '=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public')
                self.assertIn('  - archestra.env.' + variable, rendered)
