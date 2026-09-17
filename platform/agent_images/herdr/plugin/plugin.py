#!/usr/bin/env python3
"""Private Herdr adapter for advisory Agent Runtime status events."""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


READY_TEXT = b"ready\n"


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _ready_path() -> Path:
    explicit = os.environ.get("ARCHESTRA_AGENT_RUNTIME_EVENT_READY_FILE")
    if explicit:
        return Path(explicit)
    runtime_dir = Path(os.environ.get("ARCHESTRA_AGENT_RUNTIME_DIR", "/var/run/archestra"))
    return runtime_dir / "herdr-event-plugin.ready"


def ready() -> int:
    path = _ready_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        with temporary.open("wb") as output:
            output.write(READY_TEXT)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
        return 0
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _binding() -> tuple[Path, dict[str, object]] | None:
    binding_path = os.environ.get("ARCHESTRA_AGENT_RUNTIME_PANE_BINDING_FILE")
    if binding_path:
        try:
            binding = json.loads(Path(binding_path).read_text(encoding="utf-8"))
            if isinstance(binding, dict) and isinstance(binding.get("paneId"), str):
                context = Path(binding["context"])
                return context, binding
        except (OSError, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            return None
    return None


def _pane_snapshot(pane_id: str) -> dict[str, object]:
    request = {"id": "runtime-status", "method": "pane.get", "params": {"pane_id": pane_id}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        connection.connect(os.environ["HERDR_SOCKET_PATH"])
        connection.sendall(json.dumps(request).encode() + b"\n")
        with connection.makefile("rb") as response:
            line = response.readline(256 * 1024 + 1)
        if len(line) > 256 * 1024 or not line.endswith(b"\n"):
            raise ValueError("invalid pane response")
        pane = json.loads(line)["result"]["pane"]
        if pane.get("pane_id") != pane_id:
            raise ValueError("invalid pane identity")
        return pane


def status() -> int:
    binding_path = os.environ.get("ARCHESTRA_AGENT_RUNTIME_PANE_BINDING_FILE")
    if not binding_path:
        return 0
    try:
        envelope = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON", "{}"))
        # Herdr 0.9.0 uses a dotted manifest hook name, but snake_case in JSON.
        if envelope.get("event") != "pane_agent_status_changed":
            return 0
        # Hooks can run late or out of order, and Herdr 0.9.0 events have no
        # generation or timestamp. Use them only to request a current socket
        # snapshot; serializing that read and write preserves observed order.
        with Path(binding_path).with_suffix(".lock").open("a") as lock:
            deadline = time.monotonic() + 2
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("pane status reconciliation is busy")
                    time.sleep(0.05)
            bound = _binding()
            if bound is None:
                return 0
            context_path, binding = bound
            pane_id = binding["paneId"]
            if envelope.get("data", {}).get("pane_id") != pane_id:
                return 0
            pane = _pane_snapshot(pane_id)
            if _binding() != bound:
                return 0
            native_status = pane.get("agent_status")
            status = "working" if native_status == "working" else (
                "idle" if native_status in {"idle", "done", "blocked"} else "unknown"
            )
            attention = "input_required" if native_status == "blocked" else None
            payload = json.dumps({"type": "agent.status", "status": status, "attention": attention})
            environment = os.environ.copy()
            environment["ARCHESTRA_AGENT_RUNTIME_TASK_ID"] = binding["taskId"]
            environment["ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID"] = binding["attemptId"]
            result = subprocess.run([
                os.environ.get("ARCHESTRA_AGENT_EVENT_HELPER", "archestra-agent-event"),
                "emit", "--context", str(context_path),
                "--source", "herdr", payload,
            ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=environment, timeout=5)
            if result.returncode:
                sys.stderr.buffer.write(result.stderr[-2048:])
            return result.returncode
    except (KeyError, TypeError, ValueError, OSError, subprocess.TimeoutExpired):
        print("archestra: could not reconcile the current pane status", file=sys.stderr)
        return 1


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"ready", "status"}:
        print("usage: plugin.py {ready|status}", file=sys.stderr)
        return 64
    return ready() if sys.argv[1] == "ready" else status()


if __name__ == "__main__":
    raise SystemExit(main())
