"""Release version normalization preserves strict input validation."""

import json
from pathlib import Path
import tempfile
import unittest

from release_version import release_version


class ReleaseVersionTests(unittest.TestCase):
    def test_normalizes_only_an_optional_version_prefix(self):
        with tempfile.TemporaryDirectory() as work:
            spec = Path(work)/'openapi.json'
            for version in ('1.4.15', '1.5.0-rc.19'):
                for prefix in ('', 'v'):
                    with self.subTest(version=prefix + version):
                        spec.write_text(json.dumps({'info': {'version': prefix + version}}))
                        self.assertEqual(release_version(spec), version)
            for version in ('', 'latest', 'vv1.4.15', 'platform-v1.4.15',
                            'v1.4', 'v1.4.15\n', 'v1.4.15; touch injected',
                            'v1.4.15/other', None, 123):
                with self.subTest(version=version), self.assertRaises(ValueError):
                    spec.write_text(json.dumps({'info': {'version': version}}))
                    release_version(spec)
