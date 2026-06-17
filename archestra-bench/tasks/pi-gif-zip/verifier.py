"""Verify the agent's exported artifact is a valid zip containing a valid GIF.

Reads BENCH_OUTPUT (the downloaded artifact bytes). No color check by design --
we only assert the deliverable shape: a zip that holds at least one decodable GIF image.
"""

import io
import os
import zipfile

from PIL import Image


def _output_path() -> str:
    path = os.environ.get("BENCH_OUTPUT")
    assert path, "BENCH_OUTPUT is not set -- the agent did not export a downloadable artifact"
    return path


def test_artifact_is_zip_with_gif() -> None:
    with zipfile.ZipFile(_output_path()) as zf:
        assert zf.testzip() is None, "zip archive is corrupt"
        names = [n for n in zf.namelist() if not n.endswith("/")]
        assert names, "zip archive contains no files"
        gifs = []
        for name in names:
            with Image.open(io.BytesIO(zf.read(name))) as img:
                if img.format == "GIF":
                    gifs.append(name)
        assert gifs, f"zip contains no valid GIF (members: {names})"
