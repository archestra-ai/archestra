"""Exercise image handoff at the Docker command boundary."""

import gzip
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class ImageArtifactTests(unittest.TestCase):
    def test_loaded_archive_must_contain_the_requested_image(self):
        source = (ROOT / '.github/actions/load-platform-image/action.yml').read_text()
        step = source.split('    - name: Load platform Docker image\n', 1)[1].split('    - name:', 1)[0]
        script = '\n'.join(line[8:] for line in step.split('      run: |\n', 1)[1].splitlines())
        for contains_requested_image in ('true', 'false'):
            with self.subTest(contains_requested_image=contains_requested_image), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                archive = directory / 'platform-image.tar.gz'
                archive.write_bytes(gzip.compress(b'exact-runtime-image'))
                docker = directory / 'docker'
                docker.write_text('''#!/bin/bash
printf '%s\n' "$*" >> "$CALLS"
if [ "$1" = load ]; then cat > "$LOADED"; exit 0; fi
[ "$*" = "image inspect registry.test/platform:exact-run-e2e-slim" ] && [ "$CONTAINS_REQUESTED_IMAGE" = true ]
''')
                docker.chmod(0o755)
                result = subprocess.run(['bash', '-euo', 'pipefail', '-c', script.replace('/tmp/platform-image.tar.gz', str(archive))], capture_output=True, env=os.environ | {
                    'PATH': f'{directory}:{os.environ["PATH"]}',
                    'PLATFORM_IMAGE_TAG': 'registry.test/platform:exact-run-e2e-slim',
                    'CONTAINS_REQUESTED_IMAGE': contains_requested_image,
                    'CALLS': str(directory / 'calls'), 'LOADED': str(directory / 'loaded'),
                })
                self.assertEqual(result.returncode == 0, contains_requested_image == 'true', result.stderr)
                self.assertEqual((directory / 'loaded').read_bytes(), b'exact-runtime-image')
                self.assertEqual((directory / 'calls').read_text().splitlines(), ['load', 'image inspect registry.test/platform:exact-run-e2e-slim'])


if __name__ == '__main__':
    unittest.main()
