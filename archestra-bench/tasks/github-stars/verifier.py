"""Verify the submitted GitHub star count against the live `archestra-ai/archestra` count.

The star count grows without bound, so there is no sound offline fixture for "the exact current
count": this verifier fetches `stargazers_count` live (one unauthenticated request) and accepts the
submission within a small absolute tolerance that only absorbs the seconds-to-minutes drift between
the agent's fetch and this verification. A network/HTTP failure raises loudly (a labelled message in
verifier.stderr), distinct from a graded wrong answer.
"""

import json
import urllib.error
import urllib.request

from bench_verifier import result

_REPO_API = "https://api.github.com/repos/archestra-ai/archestra"
_ABS_TOL = 25  # absorbs run-to-verify star drift only; a non-fetching answer cannot land this close


def _live_stars() -> int:
    request = urllib.request.Request(
        _REPO_API,
        headers={"User-Agent": "archestra-bench", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"GitHub API request failed: {exc}") from exc
    return int(payload["stargazers_count"])


def test_stars_match() -> None:
    submitted = result()["stars"]
    live = _live_stars()
    assert abs(submitted - live) <= _ABS_TOL, (
        f"submitted {submitted} not within {_ABS_TOL} of live stargazers_count {live}"
    )
