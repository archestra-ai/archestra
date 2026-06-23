"""Verify the submitted lena.png size against recorded ground truth.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the size of
scikit-image's `skimage/data/lena.png`, in KiB floored, recorded at authoring time from the pinned
source and never staged to the agent).
"""

from bench_verifier import read_fixture_json, result


def test_size_matches() -> None:
    submitted = result()["size_kb"]
    expected = read_fixture_json("expected", "expected.json")["size_kb"]
    assert submitted == expected, f"submitted {submitted}, expected {expected}"
