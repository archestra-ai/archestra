"""Verify the agent's exported artifact: a zip holding the inverted pi-estimate GIF.

Reads BENCH_OUTPUT (the downloaded artifact bytes). We assert the deliverable shape and the
animation contract the prompt asked for -- a zip with a GIF of 60 distinct 400x400 frames. Colors
are not checked (the inversion has no staged reference to compare against).
"""

import io
import zipfile

from PIL import Image

from bench_verifier import output

FRAME_COUNT = 60
FRAME_SIZE = (400, 400)


def _frames(img: Image.Image) -> list[bytes]:
    frames: list[bytes] = []
    for i in range(getattr(img, "n_frames", 1)):
        img.seek(i)
        frames.append(img.convert("RGB").tobytes())
    return frames


def test_artifact_is_zip_with_animated_gif() -> None:
    with zipfile.ZipFile(output()) as zf:
        assert zf.testzip() is None, "zip archive is corrupt"
        names = [n for n in zf.namelist() if not n.endswith("/")]
        assert names, "zip archive contains no files"
        gifs: list[tuple[str, Image.Image]] = []
        for name in names:
            img = Image.open(io.BytesIO(zf.read(name)))
            if img.format == "GIF":
                gifs.append((name, img))
        assert gifs, f"zip contains no valid GIF (members: {names})"

        sized = [(n, img) for n, img in gifs if getattr(img, "n_frames", 1) == FRAME_COUNT]
        assert sized, (
            f"no GIF has {FRAME_COUNT} frames "
            f"(found: {[(n, getattr(img, 'n_frames', 1)) for n, img in gifs]})"
        )

        name, img = sized[0]
        assert img.size == FRAME_SIZE, f"{name}: frame size {img.size} != {FRAME_SIZE}"
        frames = _frames(img)
        assert len(set(frames)) > 1, f"{name}: all {FRAME_COUNT} frames identical -- not an animation"
