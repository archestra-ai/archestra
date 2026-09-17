"""Offline contract tests for the bounded Agent Runtime event spool."""

from __future__ import annotations

import json
import fcntl
import importlib.util
import multiprocessing
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid


HERE = Path(__file__).resolve()
BIN_DIR = HERE.parents[1] / "bin"
HELPER = shutil.which("archestra-agent-event") or str(BIN_DIR / "archestra-agent-event")
EVENT_MODULE = Path(HELPER).resolve().parent / "archestra_agent_event.py"
PACKAGED_PLUGIN = Path("/usr/local/share/archestra/herdr-plugin/plugin.py")
PLUGIN = PACKAGED_PLUGIN if PACKAGED_PLUGIN.is_file() else HERE.parents[1] / "herdr" / "plugin" / "plugin.py"
TASK = "123e4567-e89b-12d3-a456-426614174000"
ATTEMPT = "123e4567-e89b-12d3-a456-426614174001"
NEXT_ATTEMPT = "123e4567-e89b-12d3-a456-426614174002"


class RuntimeEvents(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="archestra-runtime-events-"))
        self.prefix = self.root / "turns" / TASK
        self.context = Path(f"{self.prefix}.events") / "context.json"
        self.env = os.environ.copy()
        for key in ("ARCHESTRA_AGENT_RUNTIME_TASK_ID", "ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID"):
            self.env.pop(key, None)
        catalog = Path("/usr/local/share/archestra/runtime-errors.json")
        if not catalog.is_file():
            catalog = BIN_DIR.parents[1] / "shared" / "agent-runtime-errors.json"
        self.env["ARCHESTRA_AGENT_RUNTIME_ERRORS_CATALOG"] = str(catalog)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_helper(self, *args, payload=None, env=None, check=True):
        result = subprocess.run(
            [HELPER, *args],
            input=payload,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env or self.env,
            check=False,
        )
        if check and result.returncode:
            self.fail(f"helper failed ({result.returncode}): {result.stderr}")
        return result

    def set_context(self, attempt=ATTEMPT):
        self.run_helper(
            "context",
            "--path",
            str(self.context),
            "--task",
            TASK,
            "--attempt",
            attempt,
        )

    def read(self, **kwargs):
        args = ["read", "--task", TASK, "--context", str(self.context)]
        for key, value in kwargs.items():
            args.extend([f"--{key.replace('_', '-')}", str(value)])
        return json.loads(self.run_helper(*args).stdout)

    def test_concurrent_writers_and_duplicate_delivery(self):
        self.set_context()
        payload = json.dumps({"type": "agent.status", "status": "working", "attention": None})
        processes = [
            subprocess.Popen(
                [HELPER, "emit", "--context", str(self.context), "--event-key", f"writer-{i}", payload],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self.env,
            )
            for i in range(20)
        ]
        for process in processes:
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout)["type"], "agent.status")
        events = self.read(limit=100)["events"]
        self.assertEqual([event["sequence"] for event in events], list(range(1, 21)))

        event_id = "123e4567-e89b-12d3-a456-426614174003"
        first = self.run_helper(
            "emit",
            "--context",
            str(self.context),
            "--event-id",
            event_id,
            payload=payload,
        )
        second = self.run_helper(
            "emit",
            "--context",
            str(self.context),
            "--event-id",
            event_id,
            payload=payload,
        )
        self.assertEqual(json.loads(first.stdout)["sequence"], json.loads(second.stdout)["sequence"])
        self.assertEqual(len(self.read(limit=100)["events"]), 21)

        conflict = self.run_helper(
            "emit",
            "--context",
            str(self.context),
            "--event-id",
            event_id,
            payload=json.dumps({"type": "agent.status", "status": "idle", "attention": None}),
            check=False,
        )
        self.assertEqual(conflict.returncode, 2)

    def test_concurrent_context_creation_cannot_replace_an_attempt(self):
        processes = multiprocessing.get_context("fork")
        ready = processes.Queue()
        results = processes.Queue()
        start = processes.Event()

        def create(attempt):
            spec = importlib.util.spec_from_file_location("context_race", EVENT_MODULE)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            atomic_write = module._atomic_write

            def slow_write(*args, **kwargs):
                time.sleep(0.2)
                atomic_write(*args, **kwargs)

            module._atomic_write = slow_write
            ready.put(True)
            start.wait(5)
            try:
                results.put(module.write_context(self.context, TASK, attempt)["attemptId"])
            except module.EventError:
                results.put("rejected")

        writers = [processes.Process(target=create, args=(attempt,))
                   for attempt in (ATTEMPT, NEXT_ATTEMPT)]
        for writer in writers:
            writer.start()
        for _ in writers:
            ready.get(timeout=5)
        start.set()
        outcomes = [results.get(timeout=5) for _ in writers]
        for writer in writers:
            writer.join(timeout=5)
            self.assertEqual(writer.exitcode, 0)
        self.assertEqual(outcomes.count("rejected"), 1)
        winner = next(value for value in outcomes if value != "rejected")
        self.assertEqual(json.loads(self.context.read_text())["attemptId"], winner)

    def test_restart_late_attempt_and_catalog_lookup(self):
        self.set_context()
        self.run_helper(
            "emit",
            "--context",
            str(self.context),
            payload='{"type":"diagnostic","error":{"code":"provider_auth_required"}}',
        )
        event = self.read()["events"][0]
        self.assertEqual(event["error"]["phase"], "credentials")
        self.assertTrue(event["error"]["resolution"])

        stale_env = {**self.env, "ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID": NEXT_ATTEMPT}
        stale = self.run_helper(
            "emit",
            "--context",
            str(self.context),
            payload='{"type":"agent.status","status":"working","attention":null}',
            env=stale_env,
            check=False,
        )
        self.assertEqual(stale.returncode, 2)
        retained = self.run_helper(
            "read", "--task", TASK, "--context", str(self.context), env=stale_env,
        )
        self.assertEqual(json.loads(retained.stdout)["attemptId"], ATTEMPT)
        malformed = {**event, "sequence": 2, "eventId": str(uuid.uuid4())}
        del malformed["version"]
        (self.context.parent / f'00000000000000000002-{malformed["eventId"]}.json').write_text(json.dumps(malformed))
        self.assertEqual(len(self.read()["events"]), 1)
        self.assertIn("stale", stale.stderr)

        malformed = self.run_helper(
            "emit", "--context", str(self.context), payload='{"type":"agent.status"}', check=False
        )
        self.assertEqual(malformed.returncode, 2)
        oversized = self.run_helper(
            "emit",
            "--context",
            str(self.context),
            payload=json.dumps({"type": "agent.status", "status": "working", "attention": None, "x": "x" * 5000}),
            check=False,
        )
        self.assertEqual(oversized.returncode, 2)

    def test_read_limit_and_herdr_plugin_readiness(self):
        self.set_context()
        helper_path = str(Path(HELPER).resolve())
        plugin_env = {
            **self.env,
            "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(self.prefix),
            "ARCHESTRA_AGENT_EVENT_HELPER": helper_path,
            "ARCHESTRA_AGENT_RUNTIME_EVENT_READY_FILE": str(self.root / "ready"),
            "ARCHESTRA_AGENT_RUNTIME_PANE_BINDING_FILE": str(self.root / "binding.json"),
            "HERDR_SOCKET_PATH": str(self.root / "herdr.sock"),
        }
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(plugin_env["HERDR_SOCKET_PATH"])
        server.listen()
        self.addCleanup(server.close)

        def serve_snapshots():
            for state in ["blocked", "working", "idle", "working"]:
                connection, _ = server.accept()
                with connection:
                    connection.recv(4096)
                    connection.sendall(json.dumps({"result": {"pane": {
                        "pane_id": "pane", "agent_status": state, "revision": 1,
                    }}}).encode() + b"\n")

        thread = threading.Thread(target=serve_snapshots, daemon=True)
        thread.start()
        (self.root / "binding.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "paneId": "pane",
                    "context": str(self.context),
                    "taskId": TASK,
                    "attemptId": ATTEMPT,
                }
            ),
            encoding="utf-8",
        )
        ready = subprocess.run([sys.executable, str(PLUGIN), "ready"], env=plugin_env, check=False)
        self.assertEqual(ready.returncode, 0)
        self.assertEqual((self.root / "ready").read_bytes(), b"ready\n")
        plugin_env["HERDR_PLUGIN_EVENT_JSON"] = json.dumps(
            {
                "event": "pane_agent_status_changed",
                "data": {"pane_id": "pane", "workspace_id": "workspace", "agent_status": "blocked"},
            }
        )
        status = subprocess.run([sys.executable, str(PLUGIN), "status"], env=plugin_env, check=False)
        self.assertEqual(status.returncode, 0)
        event = self.read()["events"][0]
        self.assertEqual(event["status"], "idle")
        self.assertEqual(event["attention"], "input_required")

        # Replaying an old blocked hook reconciles the current socket state.
        # Herdr pane revision does not increment for agent-status transitions.
        for _ in range(3):
            subprocess.run([sys.executable, str(PLUGIN), "status"], env=plugin_env, check=True)
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual([event["status"] for event in self.read()["events"]],
                         ["idle", "working", "idle", "working"])

        # A stuck reconciliation cannot occupy a Herdr hook worker forever.
        with (self.root / "binding.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            busy = subprocess.run([sys.executable, str(PLUGIN), "status"],
                                  env=plugin_env, capture_output=True, timeout=4)
            self.assertEqual(busy.returncode, 1)
            self.assertIn(b"could not reconcile", busy.stderr)

        # A callback delivered after the runtime clears its binding must not
        # fall back to the long-lived server's startup turn environment.
        (self.root / "binding.json").unlink()
        plugin_env["HERDR_PLUGIN_EVENT_JSON"] = json.dumps(
            {
                "event": "pane_agent_status_changed",
                "data": {"pane_id": "pane", "workspace_id": "workspace", "agent_status": "working"},
            }
        )
        late = subprocess.run([sys.executable, str(PLUGIN), "status"], env=plugin_env, check=False)
        self.assertEqual(late.returncode, 0)
        self.assertEqual(len(self.read()["events"]), 4)

        for i in range(2):
            self.run_helper(
                "emit",
                "--context",
                str(self.context),
                "--event-key",
                f"read-{i}",
                payload='{"type":"agent.status","status":"working","attention":null}',
            )
        page = self.read(after=0, limit=1)
        self.assertEqual(len(page["events"]), 1)
        self.assertEqual(page["nextSequence"], page["events"][0]["sequence"])
        self.assertTrue(page["hasMore"])

    def test_capacity_surfaces_diagnostic_and_reserves_terminal_slot(self):
        self.set_context()
        spec = importlib.util.spec_from_file_location("archestra_agent_event_test", EVENT_MODULE)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # Populate the bounded spool directly with validated event records so
        # this contract test stays quick. The next writer call must retain an
        # explicit capacity diagnostic while leaving one slot for the
        # terminal result.
        directory = self.context.parent
        directory.mkdir(parents=True, exist_ok=True)
        for index in range(module.MAX_EVENTS - 2):
            event_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"capacity-{index}"))
            event = {
                "version": 1,
                "eventId": event_id,
                "taskId": TASK,
                "attemptId": ATTEMPT,
                "sequence": index + 1,
                "source": "capacity-test",
                "observedAt": "2026-01-01T00:00:00.000Z",
                "type": "agent.status",
                "status": "working",
                "attention": None,
            }
            module._atomic_write(
                directory / f"{index + 1:020d}-{event_id}.json",
                module._json_bytes(event),
            )
        rejected = self.run_helper(
            "emit",
            "--context",
            str(self.context),
            "--event-key",
            "capacity-rejected",
            payload='{"type":"agent.status","status":"idle","attention":null}',
            check=False,
        )
        self.assertEqual(rejected.returncode, 2)
        self.assertIn("capacity", rejected.stderr)

        tail = self.read(after=module.MAX_EVENTS - 2, limit=10)["events"]
        self.assertEqual(tail[0]["type"], "diagnostic")
        self.assertEqual(tail[0]["error"]["code"], "runtime_events_unavailable")
        terminal = module.emit(
            {
                "type": "turn.finished",
                "outcome": "succeeded",
                "resultRef": "result",
            },
            self.context,
            event_key="terminal-result",
        )
        self.assertEqual(terminal["sequence"], module.MAX_EVENTS)


if __name__ == "__main__":
    unittest.main()
