# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the ai-sre-fk-drain fixture: tasks/ai-sre-fk-drain/inputs/logs.zip + expected/expected.json.

Reconstructs a real Archestra incident (commit 0e10ec8d1): deleting a conversation while its chat
run is still draining made a timer-driven event flush INSERT into chat_active_run_events with a
now-deleted runId, hitting a Postgres foreign-key violation (23503). The flush was fire-and-forget,
so the rejection went unhandled and the process exited -> the pod restarted.

The zip holds four interleaved, time-shuffled JSON-line log files (a realistic "unsorted log dump")
padded with hundreds of benign filler lines, so the signal must be filtered, not eyeballed. The
smoking gun is the ONE 23503 chain that ends in a fatal process exit. The red herrings are designed
to defeat shortcuts:
  - BENIGN 23505 unique-violations on user_tokens that recover on retry -- more frequent than the
    single fatal error, so frequency misleads.
  - A SECOND 23503 (a different table/constraint, runId `run_c2f1aa30`) that was caught and retried
    clean -- so grepping for `23503` returns two, and only correlation to the process exit picks the
    right runId for `evidence_id`.
  - An unrelated OOMKilled restart of a different pod (`otel-collector`) -- a scary "restart" that is
    not the backend crash.
The graded `evidence_id` is the runId carried by the FK error responsible for the crash, obtainable
only by correlating the process exit back to the failing flush.

Fully deterministic (fixed seed, no wall-clock, sorted JSON keys, fixed zip metadata) so the
committed zip is byte-reproducible.

Run:  uv run tasks/ai-sre-fk-drain/expected/generate.py
"""

from __future__ import annotations

import json
import random
import zipfile
from datetime import UTC, datetime
from pathlib import Path

SEED = 0xF1DBA17
BASE = datetime(2026, 6, 11, 9, 0, 0, tzinfo=UTC)
ZIP_DATE_TIME = (2026, 6, 11, 9, 0, 0)

# The planted incident identifiers (deterministic, distinctive tokens).
CONV_ID = "conv_3a9f1c20"
RUN_ID = "run_b7e44d18"  # <- the graded evidence_id
FK_CONSTRAINT = "chat_active_run_events_run_id_chat_active_runs_id_fk"

EXPECTED = {
    "root_cause_component": "chat-active-run-drain",
    "failure_class": "fk_violation_on_cascade_delete",
    "evidence_id": RUN_ID,
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


def pg_err(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


NOISE_SERVERS = ("deepwiki", "context7", "microsoft-learn")
NOISE_TOOLS = ("search", "read", "list", "fetch", "lookup")
NOISE_WINDOW_MS = 6_400


def noise(stream: str, count: int) -> list[dict[str, object]]:
    """Deterministic benign filler spread across the incident window, per log source."""
    out: list[dict[str, object]] = []
    for _ in range(count):
        off = rng.randint(0, NOISE_WINDOW_MS)
        if stream == "backend":
            kind = rng.choice(("accepted", "completed", "persisted", "validated", "health"))
            if kind == "accepted":
                out.append(line(30, "chat request accepted", off, conversationId=f"conv_{_hex(8)}", agentId="agent_main"))
            elif kind == "completed":
                out.append(line(30, "request completed", off, route="/api/chat", status=200, durationMs=rng.randint(20, 400)))
            elif kind == "persisted":
                out.append(line(30, "message persisted", off, conversationId=f"conv_{_hex(8)}", messageId=f"msg_{_hex(6)}"))
            elif kind == "validated":
                out.append(line(30, "auth token validated", off, userId=f"user_{rng.randint(1000, 9999)}"))
            else:
                out.append(line(30, "health check ok", off, route="/healthz"))
        elif stream == "worker":
            kind = rng.choice(("flush_empty", "sync", "queue", "job"))
            if kind == "flush_empty":
                out.append(line(30, "drain timer tick: nothing to flush", off, runId=f"run_{_hex(8)}", bufferedEvents=0))
            elif kind == "sync":
                out.append(line(30, "idp directory sync tick", off, idp="okta", profilesSynced=rng.randint(30, 50)))
            elif kind == "queue":
                out.append(line(30, "task queue drained", off, queue="default", depth=0))
            else:
                out.append(line(30, "scheduled job ran", off, job=rng.choice(("retention", "metrics", "compaction"))))
        elif stream == "gateway":
            if rng.random() < 0.85:
                out.append(line(30, "tool call proxied", off, server=rng.choice(NOISE_SERVERS), tool=rng.choice(NOISE_TOOLS), status=200, durationMs=rng.randint(30, 600)))
            else:
                out.append(line(40, "upstream rate limited", off, server=rng.choice(NOISE_SERVERS), status=429, retryAfterMs=1_000))
        else:  # pod
            out.append(line(30, rng.choice(("Liveness probe succeeded", "Readiness probe succeeded")), off, pod="backend-7c9d"))
    return out


# Red herring: a SECOND 23503 on an unrelated table that was caught and retried clean (no crash),
# carrying its own runId -- so `evidence_id` cannot be picked by grepping for the error code alone.
ORPHAN_RUN = "run_c2f1aa30"


# --- backend.log: the crash chain + benign user_token races + filler -----------------------------

backend: list[dict[str, object]] = [
    line(30, "active chat run started", 1_200, conversationId=CONV_ID, runId=RUN_ID, agentId="agent_main"),
    line(30, "streaming response chunk", 1_900, conversationId=CONV_ID, runId=RUN_ID, seq=14),
    line(30, "user requested conversation delete", 3_050, conversationId=CONV_ID, userId="user_5521"),
    line(30, "deleting conversation", 3_120, conversationId=CONV_ID),
    line(
        50,
        "Process exiting on unhandled rejection",
        3_540,
        err=pg_err("23503", f'insert or update on table "chat_active_run_events" violates foreign key constraint "{FK_CONSTRAINT}"'),
        runId=RUN_ID,
    ),
]

# Red herring: three benign UNIQUE-violation races on user_tokens, each recovering on retry. More
# frequent than the single 23503, and a different constraint/code, so a careless grep is misled.
for org, user, off in [("org_410", "user_7780", 600), ("org_410", "user_9120", 2_400), ("org_882", "user_3047", 4_800)]:
    backend.append(
        line(
            50,
            "failed to create user token",
            off,
            err=pg_err("23505", 'duplicate key value violates unique constraint "user_tokens_organization_id_user_id_key"'),
            organizationId=org,
            userId=user,
        )
    )
    backend.append(
        line(30, "user token created on retry", off + 90, organizationId=org, userId=user, tokenId=f"tok_{_hex(6)}")
    )

backend += [
    line(40, "slow query", 2_050, queryName="messages.listByConversation", durationMs=5_240),
    line(30, "chat request accepted", 700, conversationId=f"conv_{_hex(8)}", agentId="agent_main"),
    line(30, "chat request accepted", 4_300, conversationId=f"conv_{_hex(8)}", agentId="agent_main"),
    line(30, "health check ok", 100, route="/healthz"),
]

# --- worker.log: the drain service whose flush actually hit the FK violation ----------------------

worker: list[dict[str, object]] = [
    line(30, "drain timer tick: flushing buffered run events", 3_300, runId=RUN_ID, bufferedEvents=3),
    line(
        50,
        "failed to flush run events to chat_active_run_events",
        3_480,
        err=pg_err("23503", f'insert or update on table "chat_active_run_events" violates foreign key constraint "{FK_CONSTRAINT}"'),
        runId=RUN_ID,
        conversationId=CONV_ID,
    ),
    line(30, "drain timer tick: flushing buffered run events", 1_500, runId=f"run_{_hex(8)}", bufferedEvents=1),
    line(30, "drain timer tick: nothing to flush", 2_600, runId=f"run_{_hex(8)}", bufferedEvents=0),
    line(30, "drain worker started", 50, workers=2),
    line(30, "drain timer tick: flushing buffered run events", 2_200, runId=ORPHAN_RUN, bufferedEvents=2),
    line(
        40,
        "skipped orphaned reaction insert after fk violation (retried clean)",
        2_280,
        err=pg_err("23503", 'insert or update on table "message_reactions" violates foreign key constraint "message_reactions_message_id_messages_id_fk"'),
        runId=ORPHAN_RUN,
        recovered=True,
    ),
    line(30, "run events flushed", 2_360, runId=ORPHAN_RUN, flushed=2),
]

# --- mcp-gateway.log: pure noise (rate limits, normal traffic) ------------------------------------

gateway: list[dict[str, object]] = [
    line(40, "upstream rate limited", 1_750, server="deepwiki", status=429, retryAfterMs=1_000),
    line(40, "upstream rate limited", 4_100, server="context7", status=429, retryAfterMs=1_000),
    line(30, "tool call proxied", 900, server="microsoft-learn", tool="search", status=200),
    line(30, "tool call proxied", 2_900, server="deepwiki", tool="read", status=200),
    line(30, "gateway ready", 20, servers=3),
]

# --- pod-events.log: the externally visible symptom (the restart) ---------------------------------

pod_events: list[dict[str, object]] = [
    line(30, "Started container backend", 0, pod="backend-7c9d", node="ip-10-2-3-4"),
    line(50, "Back-off restarting failed container backend", 3_700, pod="backend-7c9d", reason="Error", exitCode=1),
    line(30, "Started container backend", 6_000, pod="backend-7c9d", node="ip-10-2-3-4", restartCount=1),
    line(30, "Liveness probe succeeded", 6_500, pod="backend-7c9d"),
    # Red herring: an unrelated pod's OOMKilled restart -- a scary "restart" that is not the crash.
    line(50, "Back-off restarting failed container otel-collector", 1_900, pod="otel-collector-2x9", reason="OOMKilled", exitCode=137),
    line(30, "Started container otel-collector", 2_400, pod="otel-collector-2x9", restartCount=4),
]

# Bury the signal in realistic volume (deterministic; rng already seeded).
backend += noise("backend", 90)
worker += noise("worker", 60)
gateway += noise("gateway", 90)
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
