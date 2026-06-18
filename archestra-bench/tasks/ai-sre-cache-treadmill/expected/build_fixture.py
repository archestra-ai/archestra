# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the ai-sre-cache-treadmill fixture: inputs/logs.zip + expected/expected.json.

Reconstructs a real Archestra incident (commit 8570c9ed5): the MCP gateway cached *negative* auth
results (a `null` lookup) with a 5s TTL, but every retry that hit the cached null re-`set` it and so
refreshed the TTL. A profile whose IdP/team binding committed within milliseconds stayed stuck on the
cached null -- a "negative-cache treadmill" of 401s at the retry interval -- and only recovered once
the retries stopped and the entry finally aged out one TTL later. The underlying state was fine
almost immediately.

The refresh-on-read bug is provable from the logs alone, not just the configured TTL: every cached
null carries a `negCacheExpiresAt` that advances by exactly the read cadence (it is always readTime +
TTL), so the entry's expiry visibly marches forward on each hit -- a fixed TTL would log a constant
expiry. Recovery lands at last-retry (+3000ms) + TTL (5000ms) = +8000ms, far past a single 5s TTL
measured from the +50ms binding, so the outage outlived the upstream fault: the cache, not the
credential, kept the 401s alive.

The zip holds four interleaved, time-shuffled JSON-line log files padded with hundreds of benign
filler lines. The red herrings are designed to defeat shortcuts:
  - A genuinely EXPIRED token for a *different* profile -- a single failure that never self-heals.
  - A DECOY profile with the identical "auth check returned cached null" symptom, but whose
    negCacheExpiresAt is FIXED (counts down): it recovers one TTL after its first miss (~5s), a
    shorter outage than the treadmill. Telling them apart needs comparing the expiry trajectories
    (sliding vs constant) / recovery latency, not just spotting "cached null then recovery".
  - rate-limit warnings and a flood of normal positive cache hits for unrelated profiles.
The graded `evidence_id` is the profileId stuck in the treadmill -- the one whose 401s persist the
LONGEST before recovering, whose binding was already committed, and whose cached-null expiry kept
getting pushed forward.

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
DECOY_PROFILE = "prof_4d12e9"  # red herring: same symptom, but a CORRECTLY-expiring fixed TTL
DECOY_TOKEN_HASH = "th_55c1a233"
TREADMILL_STEP_MS = 200
TREADMILL_COUNT = 15  # retries over ~3s before the client backs off
DECOY_FIRST_MS = 400
DECOY_STEP_MS = 400
DECOY_COUNT = 5
CACHE_TTL_MS = 5_000
BASE_MS = int(BASE.timestamp() * 1000)


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")

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


NOISE_SERVERS = ("deepwiki", "context7", "microsoft-learn")
NOISE_TOOLS = ("search", "read", "list", "fetch", "lookup")
NOISE_WINDOW_MS = 8_200


def noise(stream: str, count: int) -> list[dict[str, object]]:
    """Deterministic benign filler spread across the incident window, per log source."""
    out: list[dict[str, object]] = []
    for _ in range(count):
        off = rng.randint(0, NOISE_WINDOW_MS)
        if stream == "gateway":
            kind = rng.choice(("cache_ok", "cache_ok", "proxied", "ratelimit"))
            if kind == "cache_ok":
                out.append(line(30, "auth check served from cache", off, profileId=f"prof_{_hex(6)}", cached=True, result="ok", status=200))
            elif kind == "proxied":
                out.append(line(30, "tool call proxied", off, server=rng.choice(NOISE_SERVERS), tool=rng.choice(NOISE_TOOLS), status=200, durationMs=rng.randint(30, 600)))
            else:
                out.append(line(40, "upstream rate limited", off, server=rng.choice(NOISE_SERVERS), status=429, retryAfterMs=1_000))
        elif stream == "backend":
            kind = rng.choice(("accepted", "completed", "persisted", "health"))
            if kind == "accepted":
                out.append(line(30, "chat request accepted", off, conversationId=f"conv_{_hex(8)}", agentId="agent_main"))
            elif kind == "completed":
                out.append(line(30, "request completed", off, route="/api/chat", status=200, durationMs=rng.randint(20, 400)))
            elif kind == "persisted":
                out.append(line(30, "message persisted", off, conversationId=f"conv_{_hex(8)}", messageId=f"msg_{_hex(6)}"))
            else:
                out.append(line(30, "health check ok", off, route="/healthz"))
        elif stream == "worker":
            kind = rng.choice(("sync", "queue", "job"))
            if kind == "sync":
                out.append(line(30, "idp directory sync tick", off, idp="okta", profilesSynced=rng.randint(30, 50)))
            elif kind == "queue":
                out.append(line(30, "task queue drained", off, queue="default", depth=0))
            else:
                out.append(line(30, "scheduled job ran", off, job=rng.choice(("retention", "metrics", "compaction"))))
        else:  # pod
            out.append(line(30, rng.choice(("Liveness probe succeeded", "Readiness probe succeeded")), off, pod="backend-5f2a"))
    return out


# --- mcp-gateway.log: the treadmill + the expired-token red herring + normal traffic -------------

gateway: list[dict[str, object]] = []

# The smoking gun: a run of cached-null auth checks for one profile whose negative-cache expiry is
# re-`set` on every hit (negCacheExpiresAt = readTime + TTL), so the entry never ages out while the
# retries keep coming -- then the client backs off and it finally expires one TTL after the last hit.
for k in range(TREADMILL_COUNT):
    offset = TREADMILL_STEP_MS * (k + 1)
    expires_at = BASE_MS + offset + CACHE_TTL_MS
    gateway.append(
        line(
            40,
            "auth check returned cached null",
            offset,
            profileId=STUCK_PROFILE,
            tokenHash=STUCK_TOKEN_HASH,
            cached=True,
            result=None,
            cacheTtlMs=CACHE_TTL_MS,
            negCacheExpiresAt=expires_at,
            negCacheExpiresAtIso=_iso(expires_at),
            status=401,
        )
    )
LAST_HIT_MS = TREADMILL_STEP_MS * TREADMILL_COUNT
gateway.append(
    line(
        30,
        "auth check succeeded",
        LAST_HIT_MS + CACHE_TTL_MS,
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

# Red herring: a different profile that ALSO hits the negative cache repeatedly, but whose entry
# expires CORRECTLY -- negCacheExpiresAt is fixed (set once at first population, counting down), so it
# recovers one TTL after the FIRST miss (~5s), a shorter outage than the treadmill. The message and
# status are identical to the real incident; distinguishing it requires comparing the expiry
# trajectories (sliding vs constant) / the recovery latency, not just spotting "cached null -> recover".
decoy_expires_at = BASE_MS + DECOY_FIRST_MS + CACHE_TTL_MS
for k in range(DECOY_COUNT):
    gateway.append(
        line(
            40,
            "auth check returned cached null",
            DECOY_FIRST_MS + DECOY_STEP_MS * k,
            profileId=DECOY_PROFILE,
            tokenHash=DECOY_TOKEN_HASH,
            cached=True,
            result=None,
            cacheTtlMs=CACHE_TTL_MS,
            negCacheExpiresAt=decoy_expires_at,
            negCacheExpiresAtIso=_iso(decoy_expires_at),
            status=401,
        )
    )
gateway.append(
    line(30, "auth check succeeded", DECOY_FIRST_MS + CACHE_TTL_MS, profileId=DECOY_PROFILE, tokenHash=DECOY_TOKEN_HASH, cached=False, status=200)
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

# Bury the signal in realistic volume (deterministic; rng already seeded).
gateway += noise("gateway", 110)
backend += noise("backend", 70)
worker += noise("worker", 50)
pod_events += noise("pod", 40)


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
