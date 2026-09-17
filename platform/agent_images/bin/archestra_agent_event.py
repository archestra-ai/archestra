#!/usr/bin/env python3
"""Durable, local Agent Runtime event spool.

The helper is deliberately a small filesystem boundary.  Producers pass only
the discriminated event payload; task and attempt identity come from the
immutable context written by the runtime before a turn is launched.
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import uuid
from typing import NoReturn


VERSION = 1
EVENT_LIMIT_BYTES = 4096
MAX_EVENTS = 1000
READ_LIMIT = 100
ROOT = Path("/var/run/archestra")
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
SOURCE_RE = re.compile(r"^[a-zA-Z0-9_.:-]+$")
EVENT_FILE_RE = re.compile(r"^([0-9]+)-([0-9a-fA-F-]+)\.json$")
ISO_UTC_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$"
)
SAFE_ERROR_PHASES = {"startup", "credentials", "provider", "tool", "terminal", "protocol"}
SAFE_STATUS = {"working", "idle", "unknown"}
SAFE_ATTENTION = {None, "input_required", "auth_required"}
TERMINAL_TYPES = {"turn.finished"}
CAPACITY_EVENT_KEY = "runtime-events-unavailable"


class EventError(ValueError):
    """An input or durable-spool error that is safe to show to a producer."""


def _fail(message: str) -> NoReturn:
    raise EventError(message)


def _is_uuid(value: object) -> bool:
    return isinstance(value, str) and bool(UUID_RE.fullmatch(value))


def _safe_text(value: object, field: str, limit: int) -> str:
    if not isinstance(value, str):
        _fail(f"{field} must be text")
    value = value.strip()
    if not value:
        _fail(f"{field} must not be empty")
    if len(value) > limit:
        _fail(f"{field} exceeds {limit} characters")
    for character in value:
        code = ord(character)
        if code != 9 and code != 10 and (code < 32 or code == 127):
            _fail(f"{field} contains a control character")
        if 0xD800 <= code <= 0xDFFF:
            _fail(f"{field} contains an invalid character")
    return value


def _iso_utc(value: object | None = None) -> str:
    if value is None:
        return (
            _datetime.datetime.now(_datetime.timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    if not isinstance(value, str) or not ISO_UTC_RE.fullmatch(value):
        _fail("observedAt must be an ISO-8601 UTC timestamp ending in Z")
    try:
        parsed = _datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise EventError("observedAt is not a valid timestamp") from error
    if parsed.tzinfo != _datetime.timezone.utc:
        _fail("observedAt must use UTC")
    return value


def _uuid(value: object, field: str) -> str:
    if not _is_uuid(value):
        _fail(f"{field} must be a UUID")
    return str(value)


def _safe_source(value: object) -> str:
    source = _safe_text(value, "source", 80)
    if not SOURCE_RE.fullmatch(source):
        _fail("source contains invalid characters")
    return source


def _json_bytes(value: object) -> bytes:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
            "utf-8"
        )
    except (TypeError, UnicodeEncodeError) as error:
        raise EventError("event is not valid JSON") from error
    if len(encoded) > EVENT_LIMIT_BYTES:
        _fail(f"event exceeds {EVENT_LIMIT_BYTES} bytes")
    return encoded


def _catalog_path() -> Path:
    explicit = os.environ.get("ARCHESTRA_AGENT_RUNTIME_ERRORS_CATALOG")
    if explicit:
        return Path(explicit)
    candidates = (
        Path("/usr/local/share/archestra/runtime-errors.json"),
        Path(__file__).resolve().parents[1] / "shared" / "agent-runtime-errors.json",
        Path(__file__).resolve().parents[2] / "shared" / "agent-runtime-errors.json",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def _catalog() -> dict[str, dict[str, object]]:
    try:
        data = json.loads(_catalog_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _error_payload(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        _fail("error must be an object")
    allowed = {"code", "phase", "message", "resolution", "httpStatus"}
    unknown = set(value) - allowed
    if unknown:
        _fail("error contains unknown fields")
    code = _safe_text(value.get("code"), "error.code", 128)
    if not re.fullmatch(r"^[a-zA-Z0-9_.-]+$", code):
        _fail("error.code contains invalid characters")
    defaults = _catalog().get(code)
    if defaults is not None and not isinstance(defaults, dict):
        defaults = None
    merged: dict[str, object] = dict(defaults or {})
    merged.update(value)
    phase = _safe_text(merged.get("phase"), "error.phase", 32)
    if phase not in SAFE_ERROR_PHASES:
        _fail("error.phase is invalid")
    message = _safe_text(merged.get("message"), "error.message", 2000)
    resolution = _safe_text(merged.get("resolution"), "error.resolution", 1000)
    result: dict[str, object] = {
        "code": code,
        "phase": phase,
        "message": message,
        "resolution": resolution,
    }
    if "httpStatus" in merged and merged["httpStatus"] is not None:
        status = merged["httpStatus"]
        if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
            _fail("error.httpStatus must be between 100 and 599")
        result["httpStatus"] = status
    return result


def _context_values(context: object) -> dict[str, object]:
    if not isinstance(context, dict):
        _fail("event context must be an object")
    version = context.get("version", VERSION)
    if version != VERSION:
        _fail("unsupported event context version")
    task_id = context.get("taskId", context.get("task_id"))
    attempt_id = context.get("attemptId", context.get("attempt_id"))
    result: dict[str, object] = {
        "version": VERSION,
        "taskId": _uuid(task_id, "context.taskId"),
        "attemptId": _uuid(attempt_id, "context.attemptId"),
    }
    workspace_id = context.get("workspaceId", context.get("workspace_id"))
    if workspace_id is not None:
        result["workspaceId"] = _uuid(workspace_id, "context.workspaceId")
    return result


def load_context(path: Path, *, validate_environment: bool = True) -> dict[str, object]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise EventError(f"event context is missing: {path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise EventError("event context is malformed") from error
    context = _context_values(raw)
    if validate_environment and os.environ.get("ARCHESTRA_AGENT_RUNTIME_TASK_ID"):
        actual = os.environ["ARCHESTRA_AGENT_RUNTIME_TASK_ID"]
        if actual != context["taskId"]:
            _fail("event context task identity is stale")
    if validate_environment and os.environ.get("ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID"):
        actual = os.environ["ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID"]
        if actual != context["attemptId"]:
            _fail("event context attempt identity is stale")
    return context


def context_path_for_prefix(prefix: str | os.PathLike[str]) -> Path:
    return Path(f"{prefix}.events") / "context.json"


def turn_prefix_for_task(task_id: str) -> Path:
    task_id = _uuid(task_id, "task")
    inherited = os.environ.get("ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX")
    if inherited:
        prefix = Path(inherited)
        if prefix.name != task_id:
            _fail("requested task does not match the current turn")
        return prefix
    runtime_dir = Path(os.environ.get("ARCHESTRA_AGENT_RUNTIME_DIR", str(ROOT)))
    return runtime_dir / "turns" / task_id


def _event_dir(context_path: Path) -> Path:
    directory = context_path.parent
    if not directory.name.endswith(".events"):
        _fail("event context must be inside a .events directory")
    return directory


def _record_files(directory: Path) -> list[tuple[int, Path]]:
    records: list[tuple[int, Path]] = []
    try:
        entries = directory.iterdir()
    except FileNotFoundError:
        return records
    except OSError as error:
        raise EventError("unable to read the event spool") from error
    for path in entries:
        match = EVENT_FILE_RE.fullmatch(path.name)
        if not match or not path.is_file():
            continue
        sequence = int(match.group(1))
        if sequence <= 0:
            continue
        records.append((sequence, path))
    records.sort(key=lambda item: item[0])
    return records


def _fsync_directory(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError as error:
        if error.errno in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
            return
        raise
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / f".{path.name}.tmp.{os.getpid()}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(temporary, flags, mode)
    try:
        with os.fdopen(fd, "wb") as output:
            fd = -1
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def write_context(
    path: Path,
    task_id: str,
    attempt_id: str,
    workspace_id: str | None = None,
) -> dict[str, object]:
    _event_dir(path)
    context: dict[str, object] = {
        "version": VERSION,
        "taskId": _uuid(task_id, "taskId"),
        "attemptId": _uuid(attempt_id, "attemptId"),
    }
    if workspace_id is not None:
        context["workspaceId"] = _uuid(workspace_id, "workspaceId")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (path.parent / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists():
            existing = load_context(path)
            if existing != context:
                _fail("event context already exists with a different identity")
            return existing
        _atomic_write(path, _json_bytes(context))
    return context


def _payload_from_input(raw: object) -> tuple[dict[str, object], dict[str, object]]:
    if not isinstance(raw, dict):
        _fail("event payload must be a JSON object")
    envelope_fields = {"version", "eventId", "taskId", "attemptId", "sequence", "source", "observedAt"}
    supplied = {key: raw[key] for key in envelope_fields if key in raw}
    if "version" in supplied and supplied["version"] != VERSION:
        _fail("unsupported event version")
    payload = {key: value for key, value in raw.items() if key not in envelope_fields}
    return payload, supplied


def _normalize_payload(payload: dict[str, object], context: dict[str, object]) -> dict[str, object]:
    event_type = payload.get("type")
    if event_type not in {"agent.status", "diagnostic", "turn.finished"}:
        _fail("event type is invalid")
    if event_type == "agent.status":
        allowed = {"type", "status", "attention"}
        if set(payload) - allowed:
            _fail("agent.status contains unknown fields")
        status = payload.get("status")
        if status not in SAFE_STATUS:
            _fail("agent.status.status is invalid")
        attention = payload.get("attention")
        if attention not in SAFE_ATTENTION:
            _fail("agent.status.attention is invalid")
        return {"type": event_type, "status": status, "attention": attention}
    if event_type == "diagnostic":
        if set(payload) - {"type", "error"}:
            _fail("diagnostic contains unknown fields")
        return {"type": event_type, "error": _error_payload(payload.get("error"))}
    if set(payload) - {"type", "outcome", "error", "resultRef"}:
        _fail("turn.finished contains unknown fields")
    outcome = payload.get("outcome")
    if outcome == "failed":
        if "error" not in payload or "resultRef" in payload:
            _fail("failed turn.finished requires error and no resultRef")
        return {"type": event_type, "outcome": outcome, "error": _error_payload(payload["error"])}
    if outcome == "succeeded":
        if "resultRef" not in payload or "error" in payload:
            _fail("succeeded turn.finished requires resultRef and no error")
        result_ref = _safe_text(payload["resultRef"], "resultRef", 256)
        ref_path = Path(result_ref)
        if ref_path.is_absolute() or ".." in ref_path.parts:
            _fail("resultRef must stay inside the turn directory")
        return {"type": event_type, "outcome": outcome, "resultRef": result_ref}
    _fail("turn.finished.outcome is invalid")


def _semantic_event(event: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in event.items() if key not in {"sequence", "observedAt"}}


def _event_id_for_key(context: dict[str, object], event_key: str) -> str:
    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"archestra-agent-event:{context['taskId']}:{context['attemptId']}:{event_key}",
        )
    )


def _read_record(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_capacity_event(
    directory: Path,
    records: list[tuple[int, Path]],
    context: dict[str, object],
    source: str,
) -> dict[str, object] | None:
    """Reserve one bounded diagnostic slot before rejecting more events.

    The terminal result remains available in the final slot.  This event is
    itself idempotent, so concurrent producers all observe the same durable
    explanation rather than silently losing status updates at the cap.
    """
    event_id = _event_id_for_key(context, CAPACITY_EVENT_KEY)
    for _, path in records:
        existing = _read_record(path)
        if existing is not None and existing.get("eventId") == event_id:
            return existing
    if len(records) >= MAX_EVENTS - 1:
        return None
    # The shared catalog supplies the canonical text for this stable code.
    # Keep a complete local fallback so a custom image still surfaces the
    # bounded failure when the catalog mount is unavailable.
    try:
        error = _error_payload({"code": "runtime_events_unavailable"})
    except EventError:
        error = {
            "code": "runtime_events_unavailable",
            "phase": "protocol",
            "message": "The runtime event reporter could not initialize or save an event.",
            "resolution": "Check the runtime startup logs and available workspace storage, then restart the runtime.",
        }
    normalized = {"type": "diagnostic", "error": error}
    event: dict[str, object] = {
        "version": VERSION,
        "eventId": event_id,
        "taskId": context["taskId"],
        "attemptId": context["attemptId"],
        "sequence": records[-1][0] + 1 if records else 1,
        "source": source,
        "observedAt": _iso_utc(),
        **normalized,
    }
    encoded = _json_bytes(event)
    path = directory / f"{event['sequence']:020d}-{event_id}.json"
    _atomic_write(path, encoded)
    return event


def emit(
    payload: object,
    context_path: Path,
    event_id: str | None = None,
    source: str | None = None,
    event_key: str | None = None,
) -> dict[str, object]:
    context = load_context(context_path)
    payload, supplied = _payload_from_input(payload)
    if "taskId" in supplied and supplied["taskId"] != context["taskId"]:
        _fail("event task identity does not match its context")
    if "attemptId" in supplied and supplied["attemptId"] != context["attemptId"]:
        _fail("event attempt identity does not match its context")
    if "eventId" in supplied:
        supplied_id = _uuid(supplied["eventId"], "eventId")
        if event_id is not None and supplied_id != event_id:
            _fail("eventId was supplied twice with different values")
        event_id = supplied_id
    if event_key is not None:
        event_key = _safe_text(event_key, "event-key", 256)
        derived = _event_id_for_key(context, event_key)
        if event_id is not None and _uuid(event_id, "eventId") != derived:
            _fail("eventId does not match event-key")
        event_id = derived
    event_id = _uuid(event_id or str(uuid.uuid4()), "eventId")
    chosen_source = source or str(supplied.get("source") or os.environ.get("ARCHESTRA_AGENT_RUNTIME_EVENT_SOURCE", "archestra-agent-event"))
    chosen_source = _safe_source(chosen_source)
    observed_at = _iso_utc(supplied.get("observedAt"))
    normalized = _normalize_payload(payload, context)
    event: dict[str, object] = {
        "version": VERSION,
        "eventId": event_id,
        "taskId": context["taskId"],
        "attemptId": context["attemptId"],
        "sequence": 0,
        "source": chosen_source,
        "observedAt": observed_at,
        **normalized,
    }
    directory = _event_dir(context_path)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = directory / ".lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        records = _record_files(directory)
        for _, path in records:
            existing = _read_record(path)
            if existing is None:
                continue
            if not isinstance(existing, dict) or existing.get("eventId") != event_id:
                continue
            if _semantic_event(existing) != _semantic_event(event):
                _fail("eventId was already used for a different event")
            return existing
        terminal_present = False
        for _, path in records:
            candidate = _read_record(path)
            if isinstance(candidate, dict) and candidate.get("type") in TERMINAL_TYPES:
                terminal_present = True
                break
        if len(records) >= MAX_EVENTS:
            _fail("event spool capacity is exhausted")
        if not terminal_present and normalized["type"] not in TERMINAL_TYPES and len(records) >= MAX_EVENTS - 2:
            # At 998 records, retain a diagnostic in slot 999 and leave slot
            # 1000 for turn.finished.  A pre-existing 999-record spool cannot
            # be repaired without evicting data, so report the same bounded
            # failure and let the caller surface it.
            if len(records) == MAX_EVENTS - 2:
                _write_capacity_event(directory, records, context, chosen_source)
            _fail("event spool capacity is exhausted; terminal result slot is reserved")
        sequence = records[-1][0] + 1 if records else 1
        event["sequence"] = sequence
        encoded = _json_bytes(event)
        # Keep the context and identity immutable even when a caller supplied
        # a large diagnostic before normalization shortened it.
        if len(encoded) > EVENT_LIMIT_BYTES:
            _fail(f"event exceeds {EVENT_LIMIT_BYTES} bytes")
        path = directory / f"{sequence:020d}-{event_id}.json"
        _atomic_write(path, encoded)
        return event
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def _read_one(path: Path) -> dict[str, object] | None:
    try:
        if path.stat().st_size > EVENT_LIMIT_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("version") != VERSION:
        return None
    try:
        # The read side must never return an unvalidated object to the backend.
        context = {"taskId": value.get("taskId"), "attemptId": value.get("attemptId")}
        payload, supplied = _payload_from_input(value)
        if supplied.get("taskId") != context["taskId"] or supplied.get("attemptId") != context["attemptId"]:
            return None
        _uuid(value.get("eventId"), "eventId")
        _uuid(value.get("taskId"), "taskId")
        _uuid(value.get("attemptId"), "attemptId")
        if isinstance(value.get("sequence"), bool) or not isinstance(value.get("sequence"), int) or value["sequence"] <= 0:
            return None
        _safe_source(value.get("source"))
        _iso_utc(value.get("observedAt"))
        return {**value, **_normalize_payload(payload, context)}
    except EventError:
        return None


def read_events(task_id: str, after: int = 0, limit: int = READ_LIMIT, context_path: Path | None = None) -> dict[str, object]:
    task_id = _uuid(task_id, "task")
    if isinstance(after, bool) or not isinstance(after, int) or after < 0:
        _fail("after must be a nonnegative sequence")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= READ_LIMIT:
        _fail(f"limit must be between 1 and {READ_LIMIT}")
    if context_path is None:
        context_path = context_path_for_prefix(turn_prefix_for_task(task_id))
    # Runtime exec inherits the pod's initial task environment across turns.
    # Readers use their explicit task argument; only producers inherit identity.
    context = load_context(context_path, validate_environment=False)
    if context["taskId"] != task_id:
        _fail("event context task identity does not match the requested task")
    directory = _event_dir(context_path)
    records = _record_files(directory)
    valid: list[dict[str, object]] = []
    for sequence, path in records:
        if sequence <= after:
            continue
        event = _read_one(path)
        if event is None:
            continue
        if event.get("taskId") != task_id or event.get("attemptId") != context["attemptId"]:
            continue
        valid.append(event)
    selected = valid[:limit]
    next_sequence = selected[-1]["sequence"] if selected else after
    has_more = len(valid) > len(selected)
    return {
        "version": VERSION,
        "taskId": task_id,
        "attemptId": context["attemptId"],
        "events": selected,
        "nextSequence": next_sequence,
        "hasMore": has_more,
    }


def _payload_argument(value: str | None) -> object:
    if value is None:
        raw = sys.stdin.buffer.read(EVENT_LIMIT_BYTES + 1)
        if len(raw) > EVENT_LIMIT_BYTES:
            _fail(f"event exceeds {EVENT_LIMIT_BYTES} bytes")
    else:
        raw = value.encode("utf-8")
    if len(raw) > EVENT_LIMIT_BYTES:
        _fail(f"event exceeds {EVENT_LIMIT_BYTES} bytes")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EventError("event payload is not valid JSON") from error


def _default_context() -> Path:
    prefix = os.environ.get("ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX")
    if not prefix:
        _fail("an event context is required")
    return context_path_for_prefix(prefix)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="archestra-agent-event")
    commands = parser.add_subparsers(dest="command", required=True)

    context = commands.add_parser("context", help="create an immutable turn context")
    context.add_argument("--path", required=True, type=Path)
    context.add_argument("--task", required=True)
    context.add_argument("--attempt", required=True)
    context.add_argument("--workspace")

    emit_parser = commands.add_parser("emit", help="validate and durably write one event")
    emit_parser.add_argument("--context", type=Path)
    emit_parser.add_argument("--event-id")
    emit_parser.add_argument("--event-key", help="derive a stable event ID from this producer key")
    emit_parser.add_argument("--source")
    emit_parser.add_argument("payload", nargs="?")

    read_parser = commands.add_parser("read", help="read retained events without deleting them")
    read_parser.add_argument("--task", required=True)
    read_parser.add_argument("--after", type=int, default=0)
    read_parser.add_argument("--limit", type=int, default=READ_LIMIT)
    read_parser.add_argument("--context", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        if args.command == "context":
            result = write_context(args.path, args.task, args.attempt, args.workspace)
        elif args.command == "emit":
            result = emit(
                _payload_argument(args.payload),
                args.context or _default_context(),
                args.event_id,
                args.source,
                args.event_key,
            )
        else:
            result = read_events(args.task, args.after, args.limit, args.context)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
        return 0
    except (EventError, OSError, ValueError) as error:
        print(f"archestra-agent-event: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
