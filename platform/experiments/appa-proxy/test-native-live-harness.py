#!/usr/bin/env python3
"""Offline regression checks for the native live harness."""

from __future__ import annotations

import json
import importlib.util
import argparse
from hashlib import sha256
from http.server import ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest import mock
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
RUNNER = ROOT / "native-live-runner.py"
ASSERT = ROOT / "native-live-assert.py"
RUNTIME_URL = "http://appa-runtime.appa.svc.cluster.local"
PROXY_URL = "http://127.0.0.1:9002"
AGENT_ID = "11111111-1111-4111-8111-111111111111"
RUNNER_SPEC = importlib.util.spec_from_file_location("native_live_runner", RUNNER)
if RUNNER_SPEC is None or RUNNER_SPEC.loader is None:
    raise RuntimeError("unable to load native live runner")
RUNNER_MODULE = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER_MODULE)
COLLECTOR = ROOT / "native-live-collector.py"
COLLECTOR_SPEC = importlib.util.spec_from_file_location("native_live_collector", COLLECTOR)
if COLLECTOR_SPEC is None or COLLECTOR_SPEC.loader is None:
    raise RuntimeError("unable to load native live collector")
COLLECTOR_MODULE = importlib.util.module_from_spec(COLLECTOR_SPEC)
COLLECTOR_SPEC.loader.exec_module(COLLECTOR_MODULE)
ASSERT_SPEC = importlib.util.spec_from_file_location("native_live_assert", ASSERT)
if ASSERT_SPEC is None or ASSERT_SPEC.loader is None:
    raise RuntimeError("unable to load native live assertion")
ASSERT_MODULE = importlib.util.module_from_spec(ASSERT_SPEC)
ASSERT_SPEC.loader.exec_module(ASSERT_MODULE)
PHASE_READER = ROOT / "backend-phase-trace-reader.py"
PHASE_READER_SPEC = importlib.util.spec_from_file_location("backend_phase_trace_reader", PHASE_READER)
if PHASE_READER_SPEC is None or PHASE_READER_SPEC.loader is None:
    raise RuntimeError("unable to load backend phase trace reader")
PHASE_READER_MODULE = importlib.util.module_from_spec(PHASE_READER_SPEC)
PHASE_READER_SPEC.loader.exec_module(PHASE_READER_MODULE)
FIXTURE = ROOT / "native-live-fixture.py"
FIXTURE_SPEC = importlib.util.spec_from_file_location("native_live_fixture", FIXTURE)
if FIXTURE_SPEC is None or FIXTURE_SPEC.loader is None:
    raise RuntimeError("unable to load native live fixture")
FIXTURE_MODULE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE_MODULE)


class NativeLiveHarnessTests(unittest.TestCase):
    def test_offline_plan_uses_direct_native_proxy_and_no_relay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            completed = subprocess.run([sys.executable, str(RUNNER), "--offline", "--client", "codex", "--scenario", "public-sink", "--agent-id", AGENT_ID, "--runtime-service-url", RUNTIME_URL, "--runtime-transport-url", RUNTIME_URL, "--proxy-url", PROXY_URL, "--expected-proxy-url", PROXY_URL, "--evidence-dir", str(root)], check=True, capture_output=True, text=True)
            summary = json.loads(completed.stdout)
            plans = list(root.glob("codex/public-sink/*/plan.json"))
            self.assertEqual(summary["proxy_url"], PROXY_URL)
            self.assertEqual(len(plans), 1)
            assertion = subprocess.run([sys.executable, str(ASSERT), "--result", str(plans[0]), "--plan-only"], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(assertion.stdout)["failed"], [])

    def test_rejects_historical_relay_port(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run([sys.executable, str(RUNNER), "--offline", "--client", "claude", "--scenario", "public-sink", "--agent-id", AGENT_ID, "--runtime-service-url", RUNTIME_URL, "--runtime-transport-url", RUNTIME_URL, "--proxy-url", "http://127.0.0.1:18776", "--expected-proxy-url", "http://127.0.0.1:18776", "--evidence-dir", directory], capture_output=True, text=True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("relay", completed.stderr)

    def test_redacts_complete_private_fixture_source(self) -> None:
        source = "SYNTHETIC_PRIVATE_NOTE synthetic.person@example.test"
        self.assertEqual(
            RUNNER_MODULE.sanitize(source, "SYNTHETIC_PRIVATE_NOTE"),
            "<redacted-fixture-source>",
        )

    def test_allows_only_explicit_dev_loopback_runtime_transport(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run([sys.executable, str(RUNNER), "--offline", "--client", "codex", "--scenario", "public-sink", "--agent-id", AGENT_ID, "--runtime-service-url", "http://runtime.test.svc.cluster.local:18787", "--runtime-transport-url", "http://127.0.0.1:18787", "--allow-dev-loopback-runtime-transport", "--proxy-url", PROXY_URL, "--expected-proxy-url", PROXY_URL, "--evidence-dir", directory], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(completed.stdout)["status"], "planned")

    def test_assertion_requires_observed_public_sink_effect_and_exit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            result_path.write_text(json.dumps(self.qualifying_result()))
            completed = subprocess.run([sys.executable, str(ASSERT), "--result", str(result_path)], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(completed.stdout)["failed"], [])

    def test_qualifying_assertion_rejects_spoofed_or_incomplete_evidence(self) -> None:
        mutations = {
            "diagnostic-is-not-readiness": lambda value: value.update({"evidence_mode": "diagnostic", "qualification": {"eligible": False}}),
            "spoofed-client-label": lambda value: value.update({"client": "claude"}),
            "unrelated-counts": lambda value: value["runtime_evidence"]["linkage"].update({"interaction": False}),
            "effect-before-observation": lambda value: value["fixture_evidence"]["call_bindings"][0].update({"effect_committed_at": "2026-01-01T00:00:00Z"}),
            "changed-argument-digest": lambda value: value["fixture_evidence"]["call_bindings"][0].update({"arguments_sha256": "b" * 64}),
            "cross-root": lambda value: value["runtime_evidence"]["archestra"].update({"root_count": 2}),
            "missing-receipt": lambda value: value["runtime_evidence"]["call_bindings"][0].pop("result_admission_receipt"),
            "missing-proposal-write": lambda value: value["runtime_evidence"]["phase_traces"].update({"proposal_deliveries": []}),
        }
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            for name, mutate in mutations.items():
                value = self.qualifying_result()
                mutate(value)
                result_path.write_text(json.dumps(value))
                completed = subprocess.run([sys.executable, str(ASSERT), "--result", str(result_path)], capture_output=True, text=True)
                self.assertNotEqual(completed.returncode, 0, name)

    def test_qualifying_mode_rejects_user_selected_or_untrusted_client_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = root / "claude"
            client.write_text("#!/bin/sh\nprintf 'claude 2.1.258\\n'\n")
            client.chmod(0o700)
            provenance = root / "provenance.json"
            provenance.write_text(json.dumps({"version": 1, "clients": {"claude": {"version": "2.1.258", "sha256": RUNNER_MODULE.sha256_file(client), "launcher_path": str(client), "resolved_path": str(client)}}}))
            provenance.chmod(0o600)
            qualifying = argparse.Namespace(client="claude", client_bin=str(client), evidence_mode="qualifying")
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.verify_client_identity(qualifying)
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.read_verified_provenance(provenance)
            client.write_text("#!/bin/sh\nprintf 'claude 9.9.9\\n'\n")
            diagnostic = argparse.Namespace(client="claude", client_bin=str(client), evidence_mode="diagnostic")
            identity = RUNNER_MODULE.verify_client_identity(diagnostic)
            self.assertFalse(identity["provenance_verified"])
            self.assertEqual(identity["observed_version"], "9.9.9")

    def test_qualifying_fixture_observer_requires_full_preflight_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            observer = Path(directory) / "observer"
            observer.write_text("#!/bin/sh\nprintf '%s\\n' '{\"source\":\"trusted-fixture-audit/v1\",\"capabilities\":[\"append_only_audit_api\",\"canonical_arguments_sha256\",\"source_host_provenance\",\"fixture_event_sequences\",\"effect_commit_timestamp\",\"result_digest\",\"service_instance_identity\"]}'\n")
            observer.chmod(0o700)
            args = argparse.Namespace(evidence_mode="qualifying", fixture_evidence_command=str(observer))
            self.assertEqual(RUNNER_MODULE.verify_fixture_observer(args, "run-fixture-observer")["source"], "trusted-fixture-audit/v1")
            observer.write_text("#!/bin/sh\nprintf '%s\\n' '{\"source\":\"trusted-fixture-audit/v1\",\"capabilities\":[]}'\n")
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.verify_fixture_observer(args, "run-fixture-observer")

    def test_qualifying_runtime_trace_requires_socket_write_capabilities(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            observer = Path(directory) / "runtime-observer"
            observer.write_text("#!/bin/sh\nprintf '%s\\n' '{\"source\":\"backend-phase-trace/v1\",\"capabilities\":[\"authorization_receipt\",\"proposal_socket_write_finish\",\"result_admission_receipt\",\"continuation_socket_write_finish\"]}'\n")
            observer.chmod(0o700)
            args = argparse.Namespace(
                evidence_mode="qualifying",
                runtime_evidence_command=str(observer),
            )
            self.assertEqual(RUNNER_MODULE.verify_runtime_trace_observer(args)["source"], "backend-phase-trace/v1")
            observer.write_text("#!/bin/sh\nprintf '%s\\n' '{\"source\":\"backend-phase-trace/v1\",\"capabilities\":[]}'\n")
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.verify_runtime_trace_observer(args)

    def test_qualifying_preflight_denies_missing_provenance_gateway_and_phase_reader(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.json"
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.read_verified_provenance(missing)

            with self.assertRaises(SystemExit):
                RUNNER_MODULE.read_gateway_profile(missing)

            args = argparse.Namespace(
                evidence_mode="qualifying",
                runtime_evidence_command="false",
            )
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.verify_runtime_trace_observer(args)

    def test_qualifying_execution_requires_explicit_provenance_and_gateway_profile(self) -> None:
        args = argparse.Namespace(
            fixture_url="http://fixture.invalid",
            evidence_mode="qualifying",
            stock_provenance=None,
            gateway_profile=None,
            scenario="public-sink",
            reviewer_command=None,
            test_reviewer_id_sha256=None,
        )
        with mock.patch.dict(
            RUNNER_MODULE.os.environ,
            {
                "APPA_NATIVE_LIVE_ANTHROPIC_API_KEY": "test-key",
                "APPA_NATIVE_LIVE_OPENAI_API_KEY": "test-key",
                "APPA_NATIVE_LIVE_KIMI_API_KEY": "test-key",
                "APPA_NATIVE_FIXTURE_ADMIN_TOKEN": "test-admin-token",
            },
            clear=False,
        ):
            with self.assertRaisesRegex(SystemExit, "--stock-provenance"):
                RUNNER_MODULE.require_live_inputs(args)

    def test_gateway_token_reference_is_parsed_without_shell_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "gateway-token.env"
            reference.write_text("# private token reference\nTEST_GATEWAY_TOKEN=opaque-value\n")
            reference.chmod(0o600)
            self.assertEqual(
                RUNNER_MODULE.gateway_token("TEST_GATEWAY_TOKEN", reference),
                "opaque-value",
            )
            reference.write_text("TEST_GATEWAY_TOKEN=$(do-not-run)\n")
            with self.assertRaises(SystemExit):
                RUNNER_MODULE.gateway_token("TEST_GATEWAY_TOKEN", reference)

    def test_harness_attestation_archives_source_configuration_and_binary_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            attestation = RUNNER_MODULE.archive_harness_attestation(
                run_dir,
                {"observed_version": "0.153.0", "sha256": "a" * 64},
                {"sha256": "b" * 64},
            )
            persisted = json.loads((run_dir / "harness-attestation.json").read_text())
            self.assertEqual(attestation, persisted)
            self.assertEqual(attestation["pipeline_version"], "native-live-harness/v2")
            self.assertEqual(attestation["configuration_sha256"], "b" * 64)
            self.assertEqual(attestation["client_binary"], {"version": "0.153.0", "sha256": "a" * 64})
            self.assertEqual(set(attestation), {"pipeline_version", "source_archive_version", "source_archive", "configuration_sha256", "client_binary", "gateway_control_inventory"})
            self.assertEqual(attestation["source_archive_version"], 2)
            self.assertIsNone(attestation["gateway_control_inventory"])
            archive = attestation["source_archive"]
            self.assertEqual(set(archive["files"]), set(RUNNER_MODULE.SOURCE_ARCHIVE_FILES))
            for identity in archive["files"].values():
                self.assertIsInstance(identity["name"], str)
                self.assertRegex(identity["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(identity["bytes"], 0)
                snapshot = run_dir / identity["snapshot"]
                self.assertEqual(RUNNER_MODULE.sha256_file(snapshot), identity["sha256"])
                self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            manifest = archive["manifest"]
            self.assertEqual(manifest["name"], "source-manifest.json")
            self.assertGreater(manifest["bytes"], 0)
            self.assertEqual(RUNNER_MODULE.sha256_file(run_dir / manifest["snapshot"]), manifest["sha256"])
            self.assertEqual((run_dir / "harness-sources").stat().st_mode & 0o777, 0o700)
            self.assertEqual((run_dir / "harness-attestation.json").stat().st_mode & 0o777, 0o600)

            verified = subprocess.run(
                [sys.executable, str(run_dir / "harness-sources" / "native-live-runner.py"), "--verify-source-archive", str(run_dir)],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(json.loads(verified.stdout), {"source_archive": "verified"})

            (run_dir / archive["files"]["scenarios"]["snapshot"]).unlink()
            missing = subprocess.run(
                [sys.executable, str(run_dir / "harness-sources" / "native-live-runner.py"), "--verify-source-archive", str(run_dir)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("dependency", missing.stderr)

    def test_gateway_control_inventory_requires_exact_authenticated_surface(self) -> None:
        profile = {"client_server_key": "my_gateway", "profile_id": "00000000-0000-0000-0000-000000000001"}
        methods = [
            "archestra__run_tool",
            "archestra__search_tools",
            "archestra__appa_inspect_plan",
            "archestra__appa_status",
            "archestra__appa_execute_remedy",
        ]
        inventory = RUNNER_MODULE.project_gateway_control_inventory(
            profile,
            [{"name": method} for method in methods],
        )
        self.assertEqual(inventory["methods"], sorted(methods))
        self.assertEqual(
            inventory["client_tool_names"],
            [f"mcp__my_gateway__{method}" for method in sorted(methods)],
        )
        with self.assertRaises(SystemExit):
            RUNNER_MODULE.project_gateway_control_inventory(
                profile,
                [{"name": method} for method in methods] + [{"name": "archestra__bash"}],
            )

    def test_private_phase_reader_binds_all_four_phases_to_owner_scope(self) -> None:
        digest = "a" * 64
        scope = "b" * 64
        session = "c" * 64
        records = [
            {"event": "appa_proxy_phase_trace", "phase": "authorization_receipt", "occurred_at": "2026-01-01T00:00:01Z", "call_id_sha256": digest, "trace_id_sha256": digest, "bound_auth_scope_hash": scope, "provider": "openai", "protocol": "openai-responses", "session_id_sha256": session, "backend_instance_id": "backend-a", "delivery_semantics": "local_write_completion_not_client_execution_or_ack", "runtime_receipt_id": "11111111-1111-4111-8111-111111111111", "runtime_receipt_sha256": digest},
            {"event": "appa_proxy_phase_trace", "phase": "proposal_socket_write_finish", "occurred_at": "2026-01-01T00:00:02Z", "call_id_sha256": digest, "trace_id_sha256": digest, "bound_auth_scope_hash": scope, "provider": "openai", "protocol": "openai-responses", "session_id_sha256": session, "backend_instance_id": "backend-a", "delivery_semantics": "local_write_completion_not_client_execution_or_ack"},
            {"event": "appa_proxy_phase_trace", "phase": "result_admission_receipt", "occurred_at": "2026-01-01T00:00:04Z", "call_id_sha256": digest, "trace_id_sha256": digest, "bound_auth_scope_hash": scope, "provider": "openai", "protocol": "openai-responses", "session_id_sha256": session, "backend_instance_id": "backend-a", "delivery_semantics": "local_write_completion_not_client_execution_or_ack", "runtime_receipt_id": "22222222-2222-4222-8222-222222222222", "runtime_receipt_sha256": digest},
            {"event": "appa_proxy_phase_trace", "phase": "continuation_socket_write_finish", "occurred_at": "2026-01-01T00:00:05Z", "call_id_sha256": digest, "trace_id_sha256": digest, "bound_auth_scope_hash": scope, "provider": "openai", "protocol": "openai-responses", "session_id_sha256": session, "backend_instance_id": "backend-a", "delivery_semantics": "local_write_completion_not_client_execution_or_ack"},
        ]
        collector = {"server_binding": {"provider": "openai", "protocol": "openai-responses"}, "call_bindings": [{"call_id_sha256": digest, "session_id_sha256": session, "bound_auth_scope_hash": scope, "state": "result_admitted"}], "event_receipts": [{"event_id_sha256": sha256(b"11111111-1111-4111-8111-111111111111").hexdigest(), "request_sha256": digest, "response_sha256": digest, "event": "tool_calls", "decision": "allow_calls", "settled_at": "2026-01-01T00:00:01Z"}, {"event_id_sha256": sha256(b"22222222-2222-4222-8222-222222222222").hexdigest(), "request_sha256": digest, "response_sha256": digest, "event": "tool_result", "decision": "result_admitted", "settled_at": "2026-01-01T00:00:04Z"}]}
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "backend-phase-trace.jsonl"
            log_path.write_text("\n".join(json.dumps(record) for record in records) + "\n")
            log_path.chmod(0o600)
            parsed = PHASE_READER_MODULE.read_records(log_path)
        traces = PHASE_READER_MODULE.bind_phase_traces(collector, parsed)
        self.assertEqual([item["phase"] for item in traces["authorization_receipts"]], ["authorization_receipt"])
        self.assertEqual([item["phase"] for item in traces["proposal_deliveries"]], ["proposal_socket_write_finish"])
        self.assertEqual([item["phase"] for item in traces["result_admissions"]], ["result_admission_receipt"])
        self.assertEqual([item["phase"] for item in traces["result_releases"]], ["continuation_socket_write_finish"])

    def test_tilt_cursor_excludes_backlog_and_collects_delayed_runtime_phases(self) -> None:
        digest = "a" * 64
        scope = "b" * 64
        session = "c" * 64
        records = phase_records(digest, scope, session)
        baseline = tilt_view(2, [tilt_segment("build:1", {"event": "ignored"}), tilt_segment("localserve:1", {"event": "ignored"})])
        delayed = tilt_view(
            6,
            [
                tilt_segment("build:1", {"event": "ignored"}),
                tilt_segment("localserve:1", {"event": "ignored"}),
                *(tilt_segment("localserve:1", record) for record in records),
            ],
        )
        collector = scoped_collector(digest, scope, session)
        original_fetch = PHASE_READER_MODULE.fetch_tilt_view
        views = iter([baseline, delayed])
        PHASE_READER_MODULE.fetch_tilt_view = lambda: next(views)
        try:
            with tempfile.TemporaryDirectory() as directory:
                log_path = Path(directory) / "phase.jsonl"
                cursor_path = Path(directory) / "phase.cursor.json"
                log_path.touch(mode=0o600)
                PHASE_READER_MODULE.write_tilt_cursor(cursor_path, "pnpm-dev-backend")
                captured = PHASE_READER_MODULE.collect_tilt_cursor_records(
                    argparse.Namespace(
                        log_path=log_path,
                        tilt_cursor_path=cursor_path,
                        tilt_resource="pnpm-dev-backend",
                    ),
                    collector,
                )
                self.assertEqual([record["phase"] for record in captured], [record["phase"] for record in records])
                self.assertEqual(len(PHASE_READER_MODULE.read_records(log_path)), 4)
        finally:
            PHASE_READER_MODULE.fetch_tilt_view = original_fetch

    def test_tilt_cursor_rejects_scoped_phase_from_wrong_stream(self) -> None:
        digest = "a" * 64
        scope = "b" * 64
        session = "c" * 64
        baseline = tilt_view(0, [])
        wrong_stream = tilt_view(1, [tilt_segment("build:1", phase_records(digest, scope, session)[0])])
        original_fetch = PHASE_READER_MODULE.fetch_tilt_view
        views = iter([baseline, wrong_stream])
        PHASE_READER_MODULE.fetch_tilt_view = lambda: next(views)
        try:
            with tempfile.TemporaryDirectory() as directory:
                log_path = Path(directory) / "phase.jsonl"
                cursor_path = Path(directory) / "phase.cursor.json"
                log_path.touch(mode=0o600)
                PHASE_READER_MODULE.write_tilt_cursor(cursor_path, "pnpm-dev-backend")
                with self.assertRaises(SystemExit):
                    PHASE_READER_MODULE.collect_tilt_cursor_records(
                        argparse.Namespace(
                            log_path=log_path,
                            tilt_cursor_path=cursor_path,
                            tilt_resource="pnpm-dev-backend",
                        ),
                        scoped_collector(digest, scope, session),
                    )
        finally:
            PHASE_READER_MODULE.fetch_tilt_view = original_fetch

    def test_phase_reader_fails_closed_when_terminal_phase_never_arrives(self) -> None:
        digest = "a" * 64
        scope = "b" * 64
        session = "c" * 64
        self.assertFalse(
            PHASE_READER_MODULE.phase_capture_complete(
                phase_records(digest, scope, session)[:3], {digest}
            )
        )

    def test_runtime_sanitizer_keeps_only_safe_phase_authorization_evidence(self) -> None:
        sanitized = RUNNER_MODULE.sanitize_json(
            {
                "authorization_receipt": {
                    "runtime_receipt_id_sha256": "a" * 64,
                    "runtime_receipt_sha256": "b" * 64,
                },
                "authorization_at": "2026-01-01T00:00:00",
                "runtime_request_key": True,
                "request_key_hits": 1,
                "authorization": "secret-value",
                "token": "secret-value",
            },
            "private-marker",
        )
        self.assertEqual(
            sanitized,
            {
                "authorization_receipt": {
                    "runtime_receipt_id_sha256": "a" * 64,
                    "runtime_receipt_sha256": "b" * 64,
                },
                "authorization_at": "2026-01-01T00:00:00",
                "runtime_request_key": True,
                "request_key_hits": 1,
            },
        )

    def test_phase_reader_accepts_offset_free_persisted_settlement(self) -> None:
        digest = "a" * 64
        receipt_id = "11111111-1111-4111-8111-111111111111"
        record = {
            "phase": "authorization_receipt",
            "runtime_receipt_id": receipt_id,
            "runtime_receipt_sha256": digest,
        }
        receipts = [
            {
                "event_id_sha256": sha256(receipt_id.encode()).hexdigest(),
                "response_sha256": digest,
                "event": "tool_calls",
                "decision": "allow_calls",
                "settled_at": "2026-01-01T00:00:01.000",
            },
        ]
        PHASE_READER_MODULE.validate_event_receipt(record, receipts)

    def test_diagnostic_execution_does_not_require_runtime_trace_observer(self) -> None:
        args = argparse.Namespace(
            evidence_mode="diagnostic", runtime_evidence_command=None
        )
        self.assertIsNone(RUNNER_MODULE.verify_runtime_trace_observer(args))

    def test_collector_joins_fixture_original_arguments_to_declared_target(self) -> None:
        arguments = {"run_id": "run-20260101t000000z-abc12345", "request_key": "synthetic-join", "value": "SYNTHETIC_SERVICE_OK"}
        binding = COLLECTOR_MODULE.project_call_binding({"call_id_sha256": "a" * 64, "dispatch_id_sha256": "b" * 64, "emitted_name": "mcp__appa_fixture__publish", "emitted_arguments_sha256": "c" * 64, "target_name": "mcp__appa_fixture__publish", "target_arguments": arguments, "state": "result_admitted", "runtime_event_id_sha256": "d" * 64, "receipt_sha256": "e" * 64, "authorization_at": "2026-01-01T00:00:01Z", "receipt_at": "2026-01-01T00:00:03Z", "event_settled_at": "2026-01-01T00:00:04Z"})
        self.assertIsNotNone(binding)
        expected_digest = sha256(COLLECTOR_MODULE.canonical_json(arguments).encode()).hexdigest()
        self.assertEqual(binding["target_name"], "publish")
        self.assertEqual(binding["arguments_sha256"], expected_digest)
        observer = {"source": "trusted-fixture-audit/v1", "run_id": arguments["run_id"], "call_bindings": [{"tool_name": "publish", "arguments_sha256": expected_digest}]}
        self.assertTrue(COLLECTOR_MODULE.exact_fixture_join(arguments["run_id"], [binding], observer)["matched"])
        observer["call_bindings"][0]["arguments_sha256"] = "f" * 64
        self.assertFalse(COLLECTOR_MODULE.exact_fixture_join(arguments["run_id"], [binding], observer)["matched"])

    def test_receipt_digest_matches_node_canonicalization_vectors(self) -> None:
        vectors = [
            {"number": 0},
            {"message": "Cafe \u00e9"},
            {"z": [{"b": 0, "a": ["\u00e9", None]}], "a": {"y": True, "x": False}},
            {
                "version": 1,
                "event_id": "11111111-1111-4111-8111-111111111111",
                "request_sha256": "a" * 64,
                "decision": {"decision": "allow_calls", "calls": [{"call_id": "call-1", "tool": "publish"}]},
            },
        ]
        program = """
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(0, 'utf8'));
function stable(item) {
  if (item === null || typeof item !== 'object') return JSON.stringify(item);
  if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(',')}}`;
}
process.stdout.write(createHash('sha256').update(stable(value)).digest('hex'));
"""
        for value in vectors:
            expected = subprocess.run(
                ["node", "-e", program],
                input=json.dumps(value, ensure_ascii=False),
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            self.assertEqual(COLLECTOR_MODULE.receipt_sha256(value), expected)

    def test_denial_receipts_bind_each_publish_to_its_exact_settled_event(self) -> None:
        arguments = {"request_key": "synthetic-denial-receipt", "run_id": "run-20260101t000000z-abc12345", "value": "public-summary"}

        def binding(call_id: str, row_id: str) -> dict[str, object]:
            return {
                "id": row_id,
                "session_id": "session-1",
                "proxy_session_id": "session-1",
                "call_id": call_id,
                "call_id_sha256": sha256(call_id.encode()).hexdigest(),
                "bound_auth_scope_hash": "b" * 64,
                "target_name": "mcp__appa_fixture__publish",
                "target_arguments": arguments,
                "state": "denied",
            }

        def event(call_id: str, event_id: str, *, tool: str = "mcp__appa_fixture__publish", call_arguments: object = arguments) -> dict[str, object]:
            body = json.dumps(
                {
                    "event_id": event_id,
                    "event": {
                        "event": "tool_calls",
                        "root_id": "root-1",
                        "calls": [{"call_id": call_id, "tool": tool, "arguments": call_arguments, "spawn": False}],
                    },
                },
                separators=(",", ":"),
            )
            response = {
                "protocol_version": 1,
                "event_id": event_id,
                "request_sha256": sha256(body.encode()).hexdigest(),
                "decision": {
                    "decision": "deny_calls",
                    "calls": [{"call_id": call_id, "decision": "deny_call", "feedback": "readers are not public", "offers": [], "review": []}],
                },
            }
            return {
                "session_id": "session-1",
                "event_id": event_id,
                "event_id_sha256": sha256(event_id.encode()).hexdigest(),
                "event": "tool_calls",
                "request_body": body,
                "request_sha256": response["request_sha256"],
                "response": response,
                "decision": "deny_calls",
                "settled_at": "2026-01-01T00:00:02Z",
            }

        bindings = [binding("call-1", "row-1"), binding("call-2", "row-2")]
        events = [event("call-1", "11111111-1111-4111-8111-111111111111"), event("call-2", "22222222-2222-4222-8222-222222222222")]
        receipts = COLLECTOR_MODULE.project_denial_receipts(bindings, events)
        self.assertEqual(len(receipts), 2)
        self.assertTrue(COLLECTOR_MODULE.exact_denial_receipts_match([COLLECTOR_MODULE.project_call_binding(item) for item in bindings], receipts))
        checks: dict[str, bool] = {}
        projected_bindings = [COLLECTOR_MODULE.project_call_binding(item) for item in bindings]
        event_receipts = [COLLECTOR_MODULE.project_event_receipt(item) for item in events]
        ASSERT_MODULE.assert_denial_receipts(checks, {"denial_receipts": receipts, "event_receipts": event_receipts}, projected_bindings)
        self.assertTrue(checks["exact_denial_receipts"])
        missing_scope = [{key: value for key, value in receipt.items() if key != "bound_auth_scope_hash"} for receipt in receipts]
        ASSERT_MODULE.assert_denial_receipts(checks, {"denial_receipts": missing_scope, "event_receipts": event_receipts}, projected_bindings)
        self.assertFalse(checks["exact_denial_receipts"])
        empty_scope = [{**receipt, "bound_auth_scope_hash": ""} for receipt in receipts]
        ASSERT_MODULE.assert_denial_receipts(checks, {"denial_receipts": empty_scope, "event_receipts": event_receipts}, projected_bindings)
        self.assertFalse(checks["exact_denial_receipts"])
        mismatched_scope = [{**receipt, "bound_auth_scope_hash": "c" * 64} for receipt in receipts]
        ASSERT_MODULE.assert_denial_receipts(checks, {"denial_receipts": mismatched_scope, "event_receipts": event_receipts}, projected_bindings)
        self.assertFalse(checks["exact_denial_receipts"])
        self.assertTrue(ASSERT_MODULE.policy_decision_exit_matches({"client_exit_contract": "policy-decision"}, {"denied": True, "call_bindings": projected_bindings, "denial_receipts": receipts, "event_receipts": event_receipts}))
        self.assertFalse(ASSERT_MODULE.policy_decision_exit_matches({"client_exit_contract": "policy-decision"}, {"denied": False, "call_bindings": projected_bindings, "denial_receipts": receipts, "event_receipts": event_receipts}))
        persisted_receipts = [{**receipt, "settled_at": "2026-01-01T00:00:02"} for receipt in receipts]
        persisted_events = [{**receipt, "settled_at": "2026-01-01T00:00:02"} for receipt in event_receipts]
        ASSERT_MODULE.assert_denial_receipts(checks, {"denial_receipts": persisted_receipts, "event_receipts": persisted_events}, projected_bindings)
        self.assertTrue(checks["exact_denial_receipts"])
        bad_response_hash = [{**receipt, "response_sha256": "0" * 64} for receipt in receipts]
        ASSERT_MODULE.assert_denial_receipts(checks, {"denial_receipts": bad_response_hash, "event_receipts": event_receipts}, projected_bindings)
        self.assertFalse(checks["exact_denial_receipts"])

        wrong_call = event("unrelated-call", "33333333-3333-4333-8333-333333333333")
        self.assertEqual(COLLECTOR_MODULE.project_denial_receipts(bindings, [wrong_call, events[1]]), [])
        self.assertEqual(COLLECTOR_MODULE.project_denial_receipts(bindings, [event("call-1", "44444444-4444-4444-8444-444444444444", call_arguments={**arguments, "value": "other"}), events[1]]), [])
        self.assertEqual(COLLECTOR_MODULE.project_denial_receipts(bindings, [event("call-1", "55555555-5555-4555-8555-555555555555", tool="mcp__appa_fixture__read_source"), events[1]]), [])
        bad_hash = event("call-1", "66666666-6666-4666-8666-666666666666")
        bad_hash["request_sha256"] = "0" * 64
        self.assertEqual(COLLECTOR_MODULE.project_denial_receipts(bindings, [bad_hash, events[1]]), [])
        self.assertEqual(COLLECTOR_MODULE.project_denial_receipts(bindings, events[:1]), [])
        wrong_basis = event("call-1", "77777777-7777-4777-8777-777777777777")
        wrong_basis["response"]["decision"]["calls"][0]["feedback"] = "unrelated policy feedback"
        self.assertEqual(COLLECTOR_MODULE.project_denial_receipts(bindings, [wrong_basis, events[1]]), [])

    def qualifying_result(self) -> dict[str, object]:
        digest = "a" * 64
        return {
            "status": "completed",
            "evidence_mode": "qualifying",
            "qualification": {"eligible": True},
            "run_id": "run-20260101t000000z-abc12345",
            "fixture_observer": {"source": "trusted-fixture-audit/v1", "capabilities": ["append_only_audit_api", "canonical_arguments_sha256", "source_host_provenance", "fixture_event_sequences", "effect_commit_timestamp", "result_digest", "service_instance_identity"]},
            "runtime_trace_observer": {"source": "backend-phase-trace/v1", "capabilities": ["authorization_receipt", "proposal_socket_write_finish", "result_admission_receipt", "continuation_socket_write_finish"]},
            "gateway": {"url": "https://proxy.invalid/v1/mcp/00000000-0000-0000-0000-000000000001", "profile_id": "00000000-0000-0000-0000-000000000001", "mcp_server_id": "00000000-0000-0000-0000-000000000002", "mcp_server_name": "native-fixture-gateway", "tool_names": {"read_source": "fixture_read_source", "publish": "fixture_publish", "protected_publish": "fixture_protected_publish"}},
            "client": "codex",
            "scenario": "public-sink",
            "exit_code": 0,
            "direct_route": {"configured_proxy_url": PROXY_URL, "expected_proxy_url": PROXY_URL, "provider_base_url": "http://127.0.0.1:9002/v1/openai/agent"},
            "runtime": {"logical_service_url": RUNTIME_URL, "backend_transport_url": RUNTIME_URL, "backend_transport_kind": "cluster-dns"},
            "client_provenance": {"provenance_verified": True, "expected_version": "0.153.0", "observed_version": "0.153.0", "sha256": digest, "resolved_path": "/verified/codex"},
            "configuration": {"sha256": digest, "sanitized": {"client": "codex", "environment_names": ["OPENAI_API_KEY"], "argv": ["<verified-client>", "exec", "<scenario-prompt>"], "argv_sha256": digest}},
            "captures": {"private_source_redacted": True},
            "fixture_before": {"publication_count": 0, "audit_count": 0},
            "fixture_after": {"publication_count": 1, "private_marker_in_publication": False, "public_value_only": True, "audit_count": 3},
            "runtime_evidence": {
                "linkage": {"linked": True, "owner_bound_session": True, "server_client_identity": True, "interaction": True, "archestra_call": True, "archestra_settled_event": True, "authorized_dispatch_receipt": True, "provider_hosted_mcp_rejected": True, "runtime_journal": True, "runtime_request_key": True, "fixture_exact_call_join": True, "gateway_tool_receipt": True},
                "server_binding": {"provider": "openai", "protocol": "openai-responses", "model": "gpt-5.4"},
                "archestra": {"root_count": 1},
                "fixture_join": {"matched": True, "binding_count": 1},
                "gateway_join": {"matched": True, "receipt_count": 1},
                "call_bindings": [{"call_id_sha256": digest, "dispatch_id_sha256": digest, "emitted_name": "appa_fixture.publish", "emitted_arguments_sha256": digest, "target_name": "publish", "arguments_sha256": digest, "state": "result_admitted", "authorization_at": "2026-01-01T00:00:01Z", "authorization_receipt": {"runtime_receipt_id_sha256": digest, "runtime_receipt_sha256": digest, "event": "tool_calls", "decision": "allow_calls", "settled_at": "2026-01-01T00:00:01Z"}, "result_admission_receipt": {"runtime_receipt_id_sha256": digest, "runtime_receipt_sha256": digest, "event": "tool_result", "decision": "result_admitted", "settled_at": "2026-01-01T00:00:05Z"}}],
                "phase_traces": {"authorization_receipts": [{"source": "backend-runtime-receipt/v1", "phase": "authorization_receipt", "call_id_sha256": digest, "trace_id_sha256": digest, "persisted_at": "2026-01-01T00:00:01Z"}], "proposal_deliveries": [{"source": "backend-socket-write/v1", "phase": "proposal_socket_write_finish", "call_id_sha256": digest, "trace_id_sha256": digest, "write_finished_at": "2026-01-01T00:00:02Z"}], "result_admissions": [{"source": "backend-runtime-receipt/v1", "phase": "result_admission_receipt", "call_id_sha256": digest, "trace_id_sha256": digest, "persisted_at": "2026-01-01T00:00:05Z"}], "result_releases": [{"source": "backend-socket-write/v1", "phase": "continuation_socket_write_finish", "call_id_sha256": digest, "trace_id_sha256": digest, "write_finished_at": "2026-01-01T00:00:06Z"}]},
            },
            "fixture_evidence": {"source": "trusted-fixture-audit/v1", "run_id": "run-20260101t000000z-abc12345", "audit_record_count": 3, "service_instance_id": "fixture-1", "call_bindings": [{"invocation_id": "invocation-1", "service_instance_id": "fixture-1", "tool_name": "publish", "arguments_sha256": digest, "source_host_sha256": digest, "invoked_at": "2026-01-01T00:00:02Z", "effect_committed_at": "2026-01-01T00:00:03Z", "result_at": "2026-01-01T00:00:04Z", "result_sha256": digest, "result_status": "result_ready", "invocation_sequence": 1, "invoked_sequence": 1, "effect_committed_sequence": 2, "result_sequence": 3}]},
        }

    def test_fixture_streamable_http_authentication_and_session_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "fixture.sqlite"
            fixture_token = "fixture-token"
            admin_token = "admin-token"
            FIXTURE_MODULE.initialize(database)
            server = ThreadingHTTPServer(("127.0.0.1", 0), FIXTURE_MODULE.handler_factory(database, fixture_token, admin_token))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(Request(f"{base}/mcp"), timeout=2)
                self.assertEqual(unauthorized.exception.code, 401)
                initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
                request = Request(f"{base}/mcp", data=json.dumps(initialize).encode(), headers={"Authorization": f"Bearer {fixture_token}", "Content-Type": "application/json"})
                with urlopen(request, timeout=2) as response:
                    session_id = response.headers["Mcp-Session-Id"]
                    self.assertEqual(response.status, 200)
                headers = {"Authorization": f"Bearer {fixture_token}", "Mcp-Session-Id": session_id, "Content-Type": "application/json"}
                with urlopen(Request(f"{base}/mcp", data=b'{"jsonrpc":"2.0","method":"notifications/initialized"}', headers=headers), timeout=2) as response:
                    self.assertEqual(response.status, 202)
                with urlopen(Request(f"{base}/mcp", data=b'{"jsonrpc":"2.0","id":2,"method":"tools/list"}', headers=headers), timeout=2) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual({tool["name"] for tool in json.load(response)["result"]["tools"]}, {"read_source", "publish", "protected_publish"})
                run_id = "run-20260101t000000z-abc12345"
                RUNNER_MODULE.create_fixture_run(base, admin_token, run_id)
                call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "publish", "arguments": {"run_id": run_id, "request_key": "synthetic-persisted-fixture-evidence", "value": "SYNTHETIC_SERVICE_OK"}}}
                with urlopen(Request(f"{base}/mcp", data=json.dumps(call).encode(), headers=headers), timeout=2) as response:
                    self.assertEqual(response.status, 200)
                persisted = RUNNER_MODULE.fixture_summary(base, admin_token, run_id)
                self.assertEqual(persisted["publication_count"], 1)
                self.assertEqual(persisted["audit_count"], 3)
                sse_headers = {"Authorization": f"Bearer {fixture_token}", "Mcp-Session-Id": session_id, "Accept": "text/event-stream"}
                with urlopen(Request(f"{base}/mcp", headers=sse_headers), timeout=2) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers["content-type"], "text/event-stream")
                    self.assertEqual(response.readline(), b"event: endpoint\n")
                with urlopen(Request(f"{base}/mcp", method="DELETE", headers=sse_headers), timeout=2) as response:
                    self.assertEqual(response.status, 204)
            finally:
                server.shutdown()
                server.server_close()


    def test_gateway_claude_command_exposes_only_the_gateway_dispatcher(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(
                RUNNER_MODULE.os.environ,
                {
                    "APPA_NATIVE_LIVE_ANTHROPIC_API_KEY": "provider-key",
                    "TEST_GATEWAY_TOKEN": "gateway-token",
                },
                clear=False,
            ):
                command, _env, _transient = RUNNER_MODULE.client_command(
                    argparse.Namespace(client="claude", scenario="private-sink-denied", resume_session=None),
                    "http://127.0.0.1:9002/v1/anthropic/agent",
                    "fixture prompt",
                    Path(directory),
                    sys.executable,
                    {
                        "url": "http://127.0.0.1:9002/v1/mcp/test",
                        "token_env": "TEST_GATEWAY_TOKEN",
                        "client_server_key": "my_gateway",
                    },
                )
            wrapper = "mcp__my_gateway__archestra__run_tool"
            self.assertEqual(command[command.index("--permission-mode") + 1], "bypassPermissions")
            tools_at = command.index("--tools")
            allowed_at = command.index("--allowedTools")
            self.assertEqual(command[tools_at + 1:allowed_at], [wrapper])
            self.assertEqual(command[allowed_at + 1:command.index("--model")], [wrapper])

    def test_claude_child_command_exposes_native_agent_and_no_broad_tools(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(
                RUNNER_MODULE.os.environ,
                {
                    "APPA_NATIVE_LIVE_ANTHROPIC_API_KEY": "provider-key",
                    "TEST_GATEWAY_TOKEN": "gateway-token",
                },
                clear=False,
            ):
                command, _env, _transient = RUNNER_MODULE.client_command(
                    argparse.Namespace(client="claude", scenario="child-private-denied", resume_session=None),
                    "http://127.0.0.1:9002/v1/anthropic/agent",
                    "fixture prompt",
                    Path(directory),
                    sys.executable,
                    {
                        "url": "http://127.0.0.1:9002/v1/mcp/test",
                        "token_env": "TEST_GATEWAY_TOKEN",
                        "client_server_key": "my_gateway",
                    },
                )
            wrapper = "mcp__my_gateway__archestra__run_tool"
            tools_at = command.index("--tools")
            allowed_at = command.index("--allowedTools")
            self.assertEqual(command[tools_at + 1:allowed_at], ["Agent", wrapper])
            self.assertEqual(command[allowed_at + 1:command.index("--model")], ["Agent", wrapper])
            self.assertNotIn("Bash", command)
            self.assertNotIn("Read", command)

    def test_native_child_scenarios_are_claude_only(self) -> None:
        scenario = {"id": "child-public", "clients": ["claude"]}
        RUNNER_MODULE.validate_scenario_contract(scenario)
        with self.assertRaises(SystemExit):
            RUNNER_MODULE.validate_scenario_contract(
                {"id": "child-public", "clients": ["claude", "codex"]},
            )

    def test_vm_launcher_uses_the_runtime_health_probe(self) -> None:
        launcher = (ROOT / "native-live-vm-launch.sh").read_text()
        self.assertIn('"$runtime_transport_url/health"', launcher)
        self.assertIn("APPA_NATIVE_LIVE_RUNTIME_PROFILE", launcher)
        self.assertIn("isolated runtime profile does not attest", launcher)
        self.assertNotIn("http://127.0.0.1:18787/proxy/v1/capabilities", launcher)

    def test_vm_launcher_owns_fixture_bridge_and_health_probe(self) -> None:
        launcher = (ROOT / "native-live-vm-launch.sh").read_text()
        self.assertIn('"service/$APPA_NATIVE_LIVE_FIXTURE_SERVICE"', launcher)
        self.assertIn('"$APPA_NATIVE_LIVE_FIXTURE_URL/health"', launcher)
        self.assertIn("fixture-port-forward.log", launcher)
        self.assertIn("load_secret_reference", launcher)
        self.assertNotIn(". \"$APPA_NATIVE_LIVE_STATE_DIR/fixture-auth.env\"", launcher)

    def test_fixture_admin_request_retries_a_reset_port_forward(self) -> None:
        response = mock.Mock(status=200)
        response.read.return_value = b"{}"
        response.headers.get_content_type.return_value = "application/json"
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        with mock.patch.object(
            RUNNER_MODULE,
            "urlopen",
            side_effect=[ConnectionResetError(), response],
        ) as urlopen:
            actual = RUNNER_MODULE.fixture_admin_request(
                Request("http://fixture.test"),
            )
        self.assertEqual(actual.status, 200)
        self.assertEqual(urlopen.call_count, 2)

    def test_fixture_summary_reports_safe_invalid_json_diagnostics(self) -> None:
        response = mock.Mock(status=200, content_type="text/plain")
        response.read.return_value = b""
        with mock.patch.object(
            RUNNER_MODULE,
            "fixture_admin_request",
            return_value=response,
        ):
            with self.assertRaisesRegex(
                SystemExit,
                r"invalid JSON \(HTTP 200, content type text/plain, body bytes 0\)",
            ):
                RUNNER_MODULE.fixture_summary(
                    "http://fixture.test",
                    "private-token",
                    "run-1",
                )

    def test_claude_compaction_keeps_resume_and_drops_new_session_id(self) -> None:
        command = [
            "claude",
            "--session-id",
            "11111111-1111-4111-8111-111111111111",
            "--resume",
            "source-session",
            "-p",
            "ordinary prompt",
        ]
        compact = RUNNER_MODULE.claude_resume_compaction_command(command)
        self.assertEqual(
            compact,
            ["claude", "--resume", "source-session", "-p", "/compact"],
        )

    def test_gateway_opencode_config_uses_native_mcp_permission_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(RUNNER_MODULE.os.environ, {"APPA_NATIVE_LIVE_KIMI_API_KEY": "provider-key", "TEST_GATEWAY_TOKEN": "gateway-token"}, clear=False):
                _command, _env, transient = RUNNER_MODULE.client_command(argparse.Namespace(client="opencode", scenario="public-sink", resume_session=None), "http://127.0.0.1:9002/v1/kimi/agent", "fixture prompt", Path(directory), sys.executable, {"url": "http://127.0.0.1:9002/v1/mcp/test", "token_env": "TEST_GATEWAY_TOKEN", "client_server_key": "my_gateway"})
            config = json.loads(transient[0].read_text())
            self.assertEqual(config["mcp"]["my_gateway"]["url"], "http://127.0.0.1:9002/v1/mcp/test")
            self.assertEqual(
                config["permission"],
                {
                    "*": "deny",
                    "task": "allow",
                    "my_gateway_archestra__appa_execute_remedy": "allow",
                    "my_gateway_archestra__appa_inspect_plan": "allow",
                    "my_gateway_archestra__appa_status": "allow",
                    "my_gateway_archestra__run_tool": "allow",
                    "my_gateway_archestra__search_tools": "allow",
                },
            )
            self.assertEqual(config["provider"]["archestra-native"]["models"]["kimi-for-coding"], {"name": "Kimi for Coding", "tool_call": True, "limit": {"context": 262144, "output": 16384}})

    def test_codex_explicitly_preapproves_only_gateway_control_tools(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(
                RUNNER_MODULE.os.environ,
                {
                    "APPA_NATIVE_LIVE_OPENAI_API_KEY": "provider-key",
                    "TEST_GATEWAY_TOKEN": "gateway-token",
                },
                clear=False,
            ):
                command, _env, _transient = RUNNER_MODULE.client_command(
                    argparse.Namespace(
                        client="codex",
                        scenario="public-sink",
                        resume_session=None,
                    ),
                    "http://127.0.0.1:9002/v1/openai/agent",
                    "fixture prompt",
                    Path(directory),
                    sys.executable,
                    {
                        "url": "http://127.0.0.1:9002/v1/mcp/test",
                        "token_env": "TEST_GATEWAY_TOKEN",
                        "client_server_key": "my_gateway",
                    },
                )
        self.assertIn("--ask-for-approval", command)
        self.assertIn("never", command)
        self.assertIn("read-only", command)
        self.assertIn(
            'mcp_servers.my_gateway.enabled_tools=["archestra__appa_execute_remedy", "archestra__appa_inspect_plan", "archestra__appa_status", "archestra__run_tool", "archestra__search_tools"]',
            command,
        )
        self.assertIn(
            'mcp_servers.my_gateway.tools.archestra__run_tool.approval_mode="approve"',
            command,
        )
        self.assertIn(
            'mcp_servers.my_gateway.tools.archestra__search_tools.approval_mode="approve"',
            command,
        )
        self.assertNotIn("--approve-for-me", command)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)

def phase_records(digest: str, scope: str, session: str) -> list[dict[str, str]]:
    base = {
        "event": "appa_proxy_phase_trace",
        "call_id_sha256": digest,
        "trace_id_sha256": digest,
        "bound_auth_scope_hash": scope,
        "provider": "openai",
        "protocol": "openai-responses",
        "session_id_sha256": session,
        "backend_instance_id": "backend-a",
        "delivery_semantics": "local_write_completion_not_client_execution_or_ack",
    }
    return [
        base | {"phase": "authorization_receipt", "occurred_at": "2026-01-01T00:00:01Z", "runtime_receipt_id": "11111111-1111-4111-8111-111111111111", "runtime_receipt_sha256": digest},
        base | {"phase": "proposal_socket_write_finish", "occurred_at": "2026-01-01T00:00:02Z"},
        base | {"phase": "result_admission_receipt", "occurred_at": "2026-01-01T00:00:03Z", "runtime_receipt_id": "22222222-2222-4222-8222-222222222222", "runtime_receipt_sha256": digest},
        base | {"phase": "continuation_socket_write_finish", "occurred_at": "2026-01-01T00:00:04Z"},
    ]


def scoped_collector(digest: str, scope: str, session: str) -> dict[str, object]:
    return {
        "server_binding": {"provider": "openai", "protocol": "openai-responses"},
        "call_bindings": [{"call_id_sha256": digest, "session_id_sha256": session, "bound_auth_scope_hash": scope, "state": "result_admitted"}],
    }


def tilt_segment(span_id: str, value: dict[str, object]) -> dict[str, str]:
    return {"spanId": span_id, "time": "2026-01-01T00:00:00Z", "level": "INFO", "text": json.dumps(value)}


def tilt_view(to_checkpoint: int, segments: list[dict[str, str]]) -> dict[str, object]:
    return {
        "logList": {
            "fromCheckpoint": 0,
            "toCheckpoint": to_checkpoint,
            "segments": segments,
            "spans": {
                "localserve:1": {"manifestName": "pnpm-dev-backend"},
                "build:1": {"manifestName": "pnpm-dev-backend"},
            },
        }
    }


if __name__ == "__main__":
    unittest.main()
