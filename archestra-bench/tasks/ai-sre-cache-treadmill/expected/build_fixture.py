# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the ai-sre-cache-treadmill fixture: inputs/logs.zip + expected/expected.json.

Reconstructs a real Archestra incident (commit 8570c9ed5): the MCP gateway cached *negative* auth
results (a `null` lookup) with a 5s TTL, but every retry that hit the cached null re-`set` it and so
refreshed the TTL. A profile whose IdP/team binding committed within milliseconds stayed stuck on the
cached null -- a "negative-cache treadmill" of 401s at the retry interval -- until the loop happened
to break ~5s later. The underlying state was fine almost immediately.

The zip holds four interleaved, time-shuffled JSON-line log files. The smoking gun is one profile
whose auth check returns `cached null` repeatedly at a fixed ~200ms interval and then recovers, while
its IdP binding was already committed at t=50ms. The noise includes a genuinely EXPIRED token for a
*different* profile (a single failure that never self-heals -- the red herring), rate-limit warnings,
and normal positive cache hits. The graded `evidence_id` is the profileId stuck in the treadmill,
obtainable only by spotting the fixed-interval repeat-then-recover pattern.

Fully deterministic (fixed seed, no wall-clock, sorted JSON keys, fixed zip metadata) so the
committed zip is byte-reproducible.

Run:  uv run tasks/ai-sre-cache-treadmill/expected/build_fixture.py
"""

from __future__ import annotations

import json
import random
import zipfile
from datetime import UTC, datetime
from pathlib import Path

SEED = 0xCACE0007
BASE = datetime(2026, 5, 15, 14, 0, 0, tzinfo=UTC)
ZIP_DATE_TIME = (2026, 5, 15, 14, 0, 0)

STUCK_PROFILE = "prof_7c1a8f"  # <- the graded evidence_id (negative-cache treadmill)
STUCK_TOKEN_HASH = "th_19b2e6c0"
EXPIRED_PROFILE = "prof_b22d04"  # red herring: a real expiry that never recovers
TREADMILL_STEP_MS = 200
TREADMILL_COUNT = 24
CACHE_TTL_MS = 5_000

EXPECTED = {
    "root_cause_component": "mcp-gateway-auth-cache",
    "failure_class": "negative_cache_ttl_refresh",
    "evidence_id": STUCK_PROFILE,
}

rng = random.Random(SEED)


def _hex(n: int) -> str:
    return "".join(rng.choice("0123456789abcdef") for _ in range(n))


def line(level: int, msg: str, offset_ms: int, **fields: object) -> dict[str, object]:
    t = int(BASE.timestamp() * 1000) + offset_ms
    rec: dict[str, object] = {
        "level": level,
        "time": t,
        "timeIso": datetime.fromtimestamp(t / 1000, tz=UTC).isoformat().replace("+00:00", "Z"),
        "trace_id": _hex(16),
        "span_id": _hex(8),
        "msg": msg,
    }
    rec.update(fields)
    return rec


# --- mcp-gateway.log: the treadmill + the expired-token red herring + normal traffic -------------

gateway: list[dict[str, object]] = []

# The smoking gun: a fixed-interval run of cached-null auth checks for one profile, then recovery.
for k in range(TREADMILL_COUNT):
    gateway.append(
        line(
            40,
            "auth check returned cached null",
            TREADMILL_STEP_MS * (k + 1),
            profileId=STUCK_PROFILE,
            tokenHash=STUCK_TOKEN_HASH,
            cached=True,
            result=None,
            cacheTtlMs=CACHE_TTL_MS,
            status=401,
        )
    )
gateway.append(
    line(
        30,
        "auth check succeeded",
        TREADMILL_STEP_MS * (TREADMILL_COUNT + 1),
        profileId=STUCK_PROFILE,
        tokenHash=STUCK_TOKEN_HASH,
        cached=False,
        status=200,
    )
)

# Red herring: a genuinely expired token for a different profile -- a single failure that never
# recovers (no later success line), so it is NOT a treadmill.
gateway.append(
    line(
        40,
        "auth check failed: token expired",
        1_300,
        profileId=EXPIRED_PROFILE,
        tokenHash="th_" + _hex(8),
        cached=False,
        reason="token_expired",
        status=401,
    )
)

# Normal positive cache hits and rate-limit noise.
for off in (300, 900, 2_100, 3_600):
    gateway.append(
        line(30, "auth check served from cache", off, profileId=f"prof_{_hex(6)}", cached=True, result="ok", status=200)
    )
gateway += [
    line(40, "upstream rate limited", 2_400, server="deepwiki", status=429, retryAfterMs=1_000),
    line(30, "gateway ready", 10, servers=3),
]

# --- backend.log: the IdP/team binding that committed almost immediately (the "aha") --------------

backend: list[dict[str, object]] = [
    line(30, "idp/team binding committed", 50, profileId=STUCK_PROFILE, teamId="team_88", idp="okta"),
    line(30, "chat request accepted", 700, conversationId=f"conv_{_hex(8)}", agentId="agent_main"),
    line(30, "chat request accepted", 5_400, conversationId=f"conv_{_hex(8)}", agentId="agent_main"),
    line(40, "slow query", 1_800, queryName="profiles.findByToken", durationMs=2_100),
    line(30, "health check ok", 100, route="/healthz"),
]

# --- worker.log: benign IdP sync ticks ------------------------------------------------------------

worker: list[dict[str, object]] = [
    line(30, "idp directory sync tick", 200, idp="okta", profilesSynced=42),
    line(30, "idp directory sync tick", 5_200, idp="okta", profilesSynced=42),
    line(30, "sync worker started", 20, workers=1),
]

# --- pod-events.log: a healthy pod -- no restart (this is not an infra crash) ---------------------

pod_events: list[dict[str, object]] = [
    line(30, "Started container backend", 0, pod="backend-5f2a", node="ip-10-2-7-9"),
    line(30, "Liveness probe succeeded", 2_000, pod="backend-5f2a"),
    line(30, "Readiness probe succeeded", 2_100, pod="backend-5f2a"),
]


def serialize(records: list[dict[str, object]]) -> str:
    """Shuffle (logs arrive unsorted) then emit one sorted-key JSON object per line."""
    shuffled = records[:]
    rng.shuffle(shuffled)
    return "".join(json.dumps(r, sort_keys=True) + "\n" for r in shuffled)


def main() -> None:
    files = {
        "backend.log": serialize(backend),
        "worker.log": serialize(worker),
        "mcp-gateway.log": serialize(gateway),
        "pod-events.log": serialize(pod_events),
    }

    here = Path(__file__).resolve().parent.parent
    zip_path = here / "inputs" / "logs.zip"
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    zip_path.unlink(missing_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in sorted(files):
            info = zipfile.ZipInfo(filename=name, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, files[name])

    expected_path = here / "expected" / "expected.json"
    expected_path.write_text(json.dumps(EXPECTED, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"wrote {zip_path} ({zip_path.stat().st_size} bytes, {len(files)} log files)")
    print(f"wrote {expected_path}: {EXPECTED}")


if __name__ == "__main__":
    main()
