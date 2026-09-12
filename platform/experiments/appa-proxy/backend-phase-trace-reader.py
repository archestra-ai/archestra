#!/usr/bin/env python3
"""Read private backend APPA phase logs and bind them to collector evidence.

The log file is created by the deployment-owned launcher with mode 0600. This
reader accepts only the structured APPA phase records emitted by the backend,
then joins them to the collector's authenticated, owner-bound PostgreSQL scope.
It never returns raw call, trace, session, receipt, or backend instance IDs.
"""

from __future__ import annotations

import argparse
import datetime as dt
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import time
from typing import Any
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
CAPABILITIES = [
    "authorization_receipt",
    "proposal_socket_write_finish",
    "result_admission_receipt",
    "continuation_socket_write_finish",
]
PHASES = set(CAPABILITIES)
HASH = re.compile(r"[0-9a-f]{64}")
MAX_LOG_BYTES = 16 * 1024 * 1024
CAPTURE_DRAIN_SECONDS = 5


def main() -> int:
    args, collector_args = parse_args()
    validate_private_log(args.log_path)
    if args.capture_preflight:
        write_tilt_cursor(args.tilt_cursor_path, args.tilt_resource)
        print(json.dumps({"source": "backend-phase-trace/v1", "cursor": "ready"}, sort_keys=True))
        return 0
    if args.readiness:
        print(json.dumps({"source": "backend-phase-trace/v1", "capabilities": CAPABILITIES}, sort_keys=True))
        return 0
    if args.inspect_records:
        records = read_records(args.log_path)
        print(json.dumps({"source": "backend-phase-trace/v1", "inspection_only": True, "record_count": len(records), "records": [project_record(record) for record in records]}, sort_keys=True))
        return 0

    collector = run_collector(args.collector, collector_args)
    records = read_records(args.log_path)
    records.extend(collect_tilt_cursor_records(args, collector))
    records = deduplicate_records(records)
    records = deduplicate_records(
        drain_phase_capture(collector, records, args.log_path)
    )
    collector["phase_traces"] = bind_phase_traces(collector, records)
    bindings = collector.get("call_bindings", [])
    phase_bound = isinstance(bindings, list) and bool(bindings) and all(
        isinstance(binding, dict)
        and binding.get("state") == "denied"
        or isinstance(binding, dict)
        and "authorization_receipt" in binding
        and "result_admission_receipt" in binding
        for binding in bindings
    )
    collector["linkage"]["authorized_dispatch_receipt"] = phase_bound
    collector["linkage"]["archestra_settled_event"] = phase_bound
    collector["collector"] = "native-live-collector/v2+backend-phase-trace/v1"
    collector["proof_gaps"] = [
        gap
        for gap in collector.get("proof_gaps", [])
        if gap != "current backend evidence has no per-call authorization receipt, proposal socket-write finish, result-admission receipt, or continuation socket-write finish trace"
    ]
    print(json.dumps(collector, sort_keys=True))
    return 0


def parse_args() -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(description="Read private backend APPA phase traces")
    parser.add_argument("--readiness", action="store_true")
    parser.add_argument("--inspect-records", action="store_true")
    parser.add_argument("--capture-preflight", action="store_true")
    parser.add_argument("--collector", type=Path, default=ROOT / "native-live-collector.py")
    parser.add_argument("--log-path", type=Path, default=Path(os.environ.get("APPA_NATIVE_LIVE_PHASE_TRACE_LOG", "")))
    parser.add_argument(
        "--tilt-cursor-path",
        type=Path,
        default=(
            Path(os.environ["APPA_NATIVE_LIVE_PHASE_TRACE_CURSOR"])
            if os.environ.get("APPA_NATIVE_LIVE_PHASE_TRACE_CURSOR")
            else None
        ),
    )
    parser.add_argument("--tilt-resource", default="pnpm-dev-backend")
    args, collector_args = parser.parse_known_args()
    if not args.log_path:
        parser.error("--log-path or APPA_NATIVE_LIVE_PHASE_TRACE_LOG is required")
    if args.capture_preflight and not args.tilt_cursor_path:
        parser.error("--capture-preflight requires --tilt-cursor-path")
    return args, collector_args


def validate_private_log(path: Path) -> None:
    capture_pid = os.environ.get("APPA_NATIVE_LIVE_PHASE_TRACE_CAPTURE_PID")
    if capture_pid:
        try:
            os.kill(int(capture_pid), 0)
        except (ValueError, OSError) as error:
            raise SystemExit("backend phase-trace capture is not running") from error
    try:
        metadata = path.stat()
    except OSError as error:
        raise SystemExit("backend phase-trace log is unavailable") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit("backend phase-trace log must be a regular file")
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise SystemExit("backend phase-trace log must be owned by this user and mode 0600")
    if metadata.st_size > MAX_LOG_BYTES:
        raise SystemExit("backend phase-trace log exceeds its bounded reader limit")


def run_collector(collector: Path, collector_args: list[str]) -> dict[str, Any]:
    if not collector.is_file():
        raise SystemExit("backend phase-trace reader collector is unavailable")
    completed = subprocess.run(
        [sys.executable, str(collector), *collector_args],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        env=os.environ.copy(),
    )
    if completed.returncode != 0:
        detail = redact_failure(completed.stderr)
        raise SystemExit(
            "backend phase-trace reader could not collect owner-bound evidence"
            + (f": {detail}" if detail else ""),
        )
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit("backend phase-trace reader collector returned invalid JSON") from error
    if not isinstance(value, dict):
        raise SystemExit("backend phase-trace reader collector returned an invalid object")
    return value


def read_records(path: Path) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            candidate = parse_json_log_line(line)
            if candidate is None or candidate.get("event") != "appa_proxy_phase_trace":
                continue
            records.append(validate_record(candidate, line_number))
    return records


def write_tilt_cursor(path: Path, resource: str) -> None:
    view = fetch_tilt_view()
    log_list = tilt_log_list(view)
    spans = runtime_spans(log_list, resource)
    if not spans:
        raise SystemExit("Tilt has no active backend runtime span for phase capture")
    checkpoint = log_list.get("toCheckpoint")
    if not isinstance(checkpoint, int) or checkpoint < 0:
        raise SystemExit("Tilt phase capture has no valid log checkpoint")
    write_private_json(
        path,
        {
            "version": 1,
            "source": "tilt-view-checkpoint/v1",
            "resource": resource,
            "baseline_checkpoint": checkpoint,
            "collected_through_checkpoint": checkpoint,
            "runtime_spans": sorted(spans),
        },
    )


def collect_tilt_cursor_records(
    args: argparse.Namespace, collector: dict[str, Any]
) -> list[dict[str, str]]:
    if not args.tilt_cursor_path:
        return []
    cursor = read_tilt_cursor(args.tilt_cursor_path, args.tilt_resource)
    view = fetch_tilt_view()
    log_list = tilt_log_list(view)
    start = cursor["collected_through_checkpoint"]
    lower = log_list.get("fromCheckpoint")
    upper = log_list.get("toCheckpoint")
    segments = log_list.get("segments")
    if not isinstance(lower, int) or not isinstance(upper, int) or not isinstance(segments, list):
        raise SystemExit("Tilt phase capture checkpoint response is malformed")
    if start < lower or start > upper or upper - lower != len(segments):
        raise SystemExit("Tilt phase capture cursor is no longer available")
    expected = expected_call_hashes(collector)
    spans = log_list.get("spans")
    if not isinstance(spans, dict):
        raise SystemExit("Tilt phase capture has no span metadata")
    records: list[dict[str, str]] = []
    raw_lines: list[str] = []
    for segment in segments[start - lower :]:
        if not isinstance(segment, dict):
            raise SystemExit("Tilt phase capture contains an invalid log segment")
        text = segment.get("text")
        span_id = segment.get("spanId")
        if not isinstance(text, str) or not isinstance(span_id, str):
            continue
        candidate = parse_json_log_line(text)
        if candidate is None or candidate.get("event") != "appa_proxy_phase_trace":
            continue
        record = validate_record(candidate, start + len(records) + 1)
        if not is_runtime_span(spans.get(span_id), args.tilt_resource, span_id):
            if record["call_id_sha256"] in expected:
                raise SystemExit("scoped phase record came from a non-runtime Tilt span")
            continue
        records.append(record)
        raw_lines.append(text if text.endswith("\n") else f"{text}\n")
    if raw_lines:
        append_private_lines(args.log_path, raw_lines)
    cursor["collected_through_checkpoint"] = upper
    cursor["runtime_spans"] = sorted(runtime_spans(log_list, args.tilt_resource))
    write_private_json(args.tilt_cursor_path, cursor)
    return records


def fetch_tilt_view() -> dict[str, Any]:
    url = os.environ.get("APPA_NATIVE_LIVE_TILT_VIEW_URL")
    if not url:
        raise SystemExit("Tilt phase capture requires APPA_NATIVE_LIVE_TILT_VIEW_URL")
    try:
        with urlopen(url, timeout=5) as response:
            value = json.load(response)
    except OSError as error:
        raise SystemExit("Tilt phase capture API is unavailable") from error
    if not isinstance(value, dict):
        raise SystemExit("Tilt phase capture API returned an invalid object")
    return value


def tilt_log_list(view: dict[str, Any]) -> dict[str, Any]:
    value = view.get("logList")
    if not isinstance(value, dict):
        raise SystemExit("Tilt phase capture API has no log list")
    return value


def runtime_spans(log_list: dict[str, Any], resource: str) -> set[str]:
    spans = log_list.get("spans")
    if not isinstance(spans, dict):
        return set()
    return {
        span_id
        for span_id, metadata in spans.items()
        if isinstance(span_id, str)
        and is_runtime_span(metadata, resource, span_id)
    }


def is_runtime_span(metadata: object, resource: str, span_id: str) -> bool:
    return (
        span_id.startswith("localserve:")
        and isinstance(metadata, dict)
        and metadata.get("manifestName") == resource
    )


def read_tilt_cursor(path: Path, resource: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("Tilt phase capture cursor is unavailable") from error
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or value.get("source") != "tilt-view-checkpoint/v1"
        or value.get("resource") != resource
        or not isinstance(value.get("baseline_checkpoint"), int)
        or not isinstance(value.get("collected_through_checkpoint"), int)
    ):
        raise SystemExit("Tilt phase capture cursor is invalid")
    return value


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)


def append_private_lines(path: Path, lines: list[str]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.writelines(lines)
    os.chmod(path, 0o600)


def expected_call_hashes(collector: dict[str, Any]) -> set[str]:
    return {
        str(binding["call_id_sha256"])
        for binding in collector.get("call_bindings", [])
        if isinstance(binding, dict)
        and binding.get("state") != "denied"
        and isinstance(binding.get("call_id_sha256"), str)
    }


def deduplicate_records(records: list[dict[str, str]]) -> list[dict[str, str]]:
    unique: dict[tuple[tuple[str, str], ...], dict[str, str]] = {}
    for record in records:
        unique.setdefault(tuple(sorted(record.items())), record)
    return list(unique.values())


def parse_json_log_line(line: str) -> dict[str, Any] | None:
    start = line.find("{")
    if start < 0:
        return None
    try:
        value = json.loads(line[start:])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def validate_record(value: dict[str, Any], line_number: int) -> dict[str, str]:
    if "trace_id" in value or "session_id" in value:
        raise SystemExit(f"backend phase-trace line {line_number} contains a raw identity field")
    required = (
        "phase",
        "occurred_at",
        "call_id_sha256",
        "trace_id_sha256",
        "bound_auth_scope_hash",
        "provider",
        "protocol",
        "session_id_sha256",
        "backend_instance_id",
        "delivery_semantics",
    )
    if any(not isinstance(value.get(key), str) for key in required):
        raise SystemExit(f"backend phase-trace line {line_number} has an invalid shape")
    record = {key: str(value[key]) for key in required}
    if record["phase"] not in PHASES:
        raise SystemExit(f"backend phase-trace line {line_number} has an unknown phase")
    if record["delivery_semantics"] != "local_write_completion_not_client_execution_or_ack":
        raise SystemExit(f"backend phase-trace line {line_number} has unsafe delivery semantics")
    if any(not HASH.fullmatch(record[key]) for key in ("call_id_sha256", "trace_id_sha256", "session_id_sha256", "bound_auth_scope_hash")):
        raise SystemExit(f"backend phase-trace line {line_number} has an invalid hash")
    if parse_timestamp(record["occurred_at"]) is None:
        raise SystemExit(f"backend phase-trace line {line_number} has an invalid timestamp")
    receipt_keys = ("runtime_receipt_id", "runtime_receipt_sha256")
    has_receipt = all(isinstance(value.get(key), str) for key in receipt_keys)
    if record["phase"] in {"authorization_receipt", "result_admission_receipt"}:
        if not has_receipt or not HASH.fullmatch(str(value["runtime_receipt_sha256"])):
            raise SystemExit(f"backend phase-trace line {line_number} lacks a validated runtime receipt")
        record.update({key: str(value[key]) for key in receipt_keys})
    elif any(key in value for key in receipt_keys):
        raise SystemExit(f"backend phase-trace line {line_number} attaches a receipt to a socket phase")
    return record


def bind_phase_traces(collector: dict[str, Any], records: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    bindings = collector.get("call_bindings")
    server_binding = collector.get("server_binding")
    event_receipts = collector.get("event_receipts")
    if not isinstance(bindings, list) or not isinstance(server_binding, dict) or not isinstance(event_receipts, list):
        raise SystemExit("backend phase-trace reader has no authenticated collector scope")
    expected = {
        str(binding["call_id_sha256"]): binding
        for binding in bindings
        if isinstance(binding, dict)
        and binding.get("state") != "denied"
        and all(isinstance(binding.get(key), str) for key in ("call_id_sha256", "session_id_sha256", "bound_auth_scope_hash"))
    }
    if not expected:
        raise SystemExit("backend phase-trace reader found no eligible owner-bound calls")
    groups = {
        "authorization_receipts": [],
        "proposal_deliveries": [],
        "result_admissions": [],
        "result_releases": [],
    }
    for record in records:
        binding = expected.get(record["call_id_sha256"])
        if binding is None:
            continue
        if (
            record["provider"] != server_binding.get("provider")
            or record["protocol"] != server_binding.get("protocol")
            or record["session_id_sha256"] != binding.get("session_id_sha256")
            or record["bound_auth_scope_hash"] != binding.get("bound_auth_scope_hash")
        ):
            raise SystemExit("backend phase-trace record does not match the authenticated collector scope")
        group = phase_group(record["phase"])
        if "runtime_receipt_id" in record:
            validate_event_receipt(record, event_receipts)
        groups[group].append(project_record(record))

    for call_id, binding in expected.items():
        phase_records = {
            group: [record for record in records_for_call(groups[group], call_id)]
            for group in groups
        }
        if any(len(value) != 1 for value in phase_records.values()):
            raise SystemExit("backend phase-trace evidence is missing or duplicated for an owner-bound call")
        timestamps = [
            timestamp_for(phase_records["authorization_receipts"][0]),
            timestamp_for(phase_records["proposal_deliveries"][0]),
            timestamp_for(phase_records["result_admissions"][0]),
            timestamp_for(phase_records["result_releases"][0]),
        ]
        if timestamps != sorted(timestamps):
            raise SystemExit("backend phase-trace evidence has an invalid phase order")
        binding["authorization_receipt"] = receipt_binding(
            phase_records["authorization_receipts"][0],
            "tool_calls",
            "allow_calls",
        )
        binding["result_admission_receipt"] = receipt_binding(
            phase_records["result_admissions"][0],
            "tool_result",
            "result_admitted",
        )
    return groups


def drain_phase_capture(
    collector: dict[str, Any], records: list[dict[str, str]], log_path: Path
) -> list[dict[str, str]]:
    """Follow only the deployment-owned capture until scoped phases settle.

    Tilt's log follower can receive a final socket-write record after the client
    exits. The database scope is read once; a short-lived tail process supplies
    only newly appended records and never manufactures missing evidence.
    """
    expected = expected_call_hashes(collector)
    if not expected or phase_capture_complete(records, expected):
        return records
    follower = subprocess.Popen(
        ["tail", "-n", "0", "-F", str(log_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    deadline = time.monotonic() + CAPTURE_DRAIN_SECONDS
    try:
        while time.monotonic() < deadline:
            if follower.stdout is None:
                break
            remaining = deadline - time.monotonic()
            ready, _, _ = select.select([follower.stdout], [], [], remaining)
            if not ready:
                break
            line = follower.stdout.readline()
            candidate = parse_json_log_line(line)
            if candidate is None or candidate.get("event") != "appa_proxy_phase_trace":
                continue
            records.append(validate_record(candidate, len(records) + 1))
            if phase_capture_complete(records, expected):
                return records
    finally:
        follower.terminate()
        follower.wait(timeout=1)
    return records


def phase_capture_complete(records: list[dict[str, str]], expected: set[str]) -> bool:
    phases = {call_id: [] for call_id in expected}
    for record in records:
        call_id = record.get("call_id_sha256")
        if call_id in phases:
            phases[call_id].append(record.get("phase"))
    return all(sorted(values) == sorted(CAPABILITIES) for values in phases.values())


def validate_event_receipt(record: dict[str, str], receipts: list[object]) -> None:
    event_id_sha256 = sha256(record["runtime_receipt_id"].encode()).hexdigest()
    expected_event, expected_decision = (
        ("tool_calls", "allow_calls")
        if record["phase"] == "authorization_receipt"
        else ("tool_result", "result_admitted")
    )
    matches = [
        receipt
        for receipt in receipts
        if isinstance(receipt, dict)
        and receipt.get("event_id_sha256") == event_id_sha256
        and receipt.get("response_sha256") == record["runtime_receipt_sha256"]
        and receipt.get("event") == expected_event
        and receipt.get("decision") == expected_decision
        and parse_persisted_settlement(receipt.get("settled_at"))
    ]
    if len(matches) != 1:
        raise SystemExit("backend phase receipt does not match one settled APPA event")


def phase_group(phase: str) -> str:
    return {
        "authorization_receipt": "authorization_receipts",
        "proposal_socket_write_finish": "proposal_deliveries",
        "result_admission_receipt": "result_admissions",
        "continuation_socket_write_finish": "result_releases",
    }[phase]


def receipt_binding(
    record: dict[str, str], event: str, decision: str
) -> dict[str, str]:
    return {
        "runtime_receipt_id_sha256": record.get("runtime_receipt_id_sha256")
        or sha256(record["runtime_receipt_id"].encode()).hexdigest(),
        "runtime_receipt_sha256": record["runtime_receipt_sha256"],
        "event": event,
        "decision": decision,
        "settled_at": record.get("persisted_at") or record["occurred_at"],
    }


def project_record(record: dict[str, str]) -> dict[str, str]:
    projected = {
        "source": "backend-runtime-receipt/v1" if record["phase"] in {"authorization_receipt", "result_admission_receipt"} else "backend-socket-write/v1",
        "phase": record["phase"],
        "call_id_sha256": record["call_id_sha256"],
        "trace_id_sha256": record["trace_id_sha256"],
        "session_id_sha256": record["session_id_sha256"],
        "bound_auth_scope_hash": record["bound_auth_scope_hash"],
        "provider": record["provider"],
        "protocol": record["protocol"],
        "backend_instance_id_sha256": sha256(record["backend_instance_id"].encode()).hexdigest(),
    }
    if "runtime_receipt_id" in record:
        projected["runtime_receipt_id_sha256"] = sha256(record["runtime_receipt_id"].encode()).hexdigest()
        projected["runtime_receipt_sha256"] = record["runtime_receipt_sha256"]
        projected["persisted_at"] = record["occurred_at"]
    else:
        projected["write_finished_at"] = record["occurred_at"]
    return projected


def records_for_call(records: list[dict[str, str]], call_id: str) -> list[dict[str, str]]:
    return [record for record in records if record.get("call_id_sha256") == call_id]


def timestamp_for(record: dict[str, str]) -> dt.datetime:
    value = record.get("persisted_at") or record.get("write_finished_at")
    parsed = parse_timestamp(value)
    if parsed is None:
        raise SystemExit("backend phase-trace projection lost its timestamp")
    return parsed


def parse_timestamp(value: object) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def parse_persisted_settlement(value: object) -> bool:
    """Validate the database value without fabricating timezone information.

    Phase-log timestamps are RFC 3339 and must carry an offset. The receipt
    table intentionally uses PostgreSQL `timestamp` and therefore returns an
    offset-free ISO value through JSON. Its non-null, parseable value proves a
    settled receipt; treating it as a log timestamp rejects valid evidence.
    """
    if not isinstance(value, str):
        return False
    try:
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def redact_failure(value: str) -> str:
    # This text is persisted only in the run-private diagnostic artifact. Keep
    # it bounded and remove the credential spellings subprocesses commonly use.
    value = value[-1000:]
    return re.sub(
        r"(?i)(authorization|bearer|token|password)=?\S+",
        r"\1=<redacted>",
        value,
    ).strip()


if __name__ == "__main__":
    raise SystemExit(main())
