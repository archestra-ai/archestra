#!/usr/bin/env python3
"""Assert sanitized native APPA live-run evidence without reading credentials."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import sys
from typing import Any


ROOT = Path(__file__).resolve().parent
EXPECTED_BACKEND_IDENTITIES = {
    "claude": {"provider": "anthropic", "protocol": "anthropic-messages", "model": "claude-haiku-4-5"},
    "codex": {"provider": "openai", "protocol": "openai-responses", "model": "gpt-5.4"},
    "opencode": {"provider": "kimi", "protocol": "openai-chat-completions", "model": "kimi-for-coding"},
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Assert a native APPA live fixture result")
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--scenarios", type=Path, default=ROOT / "native-live-scenarios.json")
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    result = read_json(args.result)
    scenarios = read_json(args.scenarios)
    scenario = next((item for item in scenarios["scenarios"] if item["id"] == result.get("scenario")), None)
    checks: dict[str, bool] = {}
    check(checks, "scenario_known", scenario is not None)
    check(checks, "direct_proxy_matches_expected", result.get("direct_route", {}).get("configured_proxy_url") == result.get("direct_route", {}).get("expected_proxy_url"))
    route = str(result.get("direct_route", {}).get("provider_base_url", ""))
    configured_proxy = str(result.get("direct_route", {}).get("configured_proxy_url", "")).rstrip("/")
    check(checks, "provider_route_uses_direct_proxy", route.startswith(configured_proxy + "/v1/"))
    check(checks, "no_relay_route", "relay" not in route.lower() and not any(f":{port}" in route for port in range(18700, 18800)))
    runtime = result.get("runtime", {})
    logical = str(runtime.get("logical_service_url", ""))
    transport = str(runtime.get("backend_transport_url", ""))
    kind = runtime.get("backend_transport_kind")
    check(checks, "logical_runtime_identity", logical.startswith("http://") and ".svc.cluster.local" in logical)
    check(checks, "backend_runtime_transport", (kind == "cluster-dns" and transport == logical) or (kind == "dev-loopback-port-forward" and transport.startswith("http://127.0.0.1:")))
    if args.plan_only:
        check(checks, "plan_is_not_live_readiness", result.get("qualification", {}).get("eligible") is False)
        return report(checks)
    check(checks, "completed", result.get("status") == "completed")
    check(checks, "qualifying_evidence_mode", result.get("evidence_mode") == "qualifying")
    check(checks, "qualifying_run_eligible", result.get("qualification", {}).get("eligible") is True)
    gateway = result.get("gateway")
    check(checks, "real_mcp_gateway_topology", isinstance(gateway, dict) and isinstance(gateway.get("url"), str) and isinstance(gateway.get("profile_id"), str) and gateway["url"].endswith(f"/v1/mcp/{gateway['profile_id']}") and isinstance(gateway.get("mcp_server_id"), str) and isinstance(gateway.get("mcp_server_name"), str) and isinstance(gateway.get("tool_names"), dict))
    observer = result.get("fixture_observer", {})
    capabilities = observer.get("capabilities") if isinstance(observer, dict) else None
    check(checks, "fixture_observer_preflighted", isinstance(observer, dict) and observer.get("source") == "trusted-fixture-audit/v1" and isinstance(capabilities, list) and {"append_only_audit_api", "canonical_arguments_sha256", "source_host_provenance", "fixture_event_sequences", "effect_commit_timestamp", "result_digest", "service_instance_identity"}.issubset(set(capabilities)))
    runtime_observer = result.get("runtime_trace_observer", {})
    runtime_capabilities = runtime_observer.get("capabilities") if isinstance(runtime_observer, dict) else None
    check(checks, "runtime_phase_trace_preflighted", isinstance(runtime_observer, dict) and runtime_observer.get("source") == "backend-phase-trace/v1" and isinstance(runtime_capabilities, list) and {"authorization_receipt", "proposal_socket_write_finish", "result_admission_receipt", "continuation_socket_write_finish"}.issubset(set(runtime_capabilities)))
    assert_client_provenance(checks, result)
    assert_configuration_fingerprint(checks, result)
    check(checks, "private_capture_redacted", result.get("captures", {}).get("private_source_redacted") is True)
    runtime_evidence = result.get("runtime_evidence")
    check(checks, "runtime_evidence_present", isinstance(runtime_evidence, dict) and runtime_evidence.get("collector_status") is None)
    if isinstance(runtime_evidence, dict):
        assert_evidence_contract(checks, runtime_evidence, str(result.get("client", "")))
    assert_fixture_evidence(checks, result, runtime_evidence if isinstance(runtime_evidence, dict) else {})
    if scenario is not None:
        expected = scenario.get("expect", {})
        policy_decision_exit = policy_decision_exit_matches(scenario, runtime_evidence)
        check(
            checks,
            "client_exit_matches_scenario",
            policy_decision_exit or result.get("exit_code") == scenario.get("expected_exit"),
        )
        after = result.get("fixture_after", {})
        if "publication_count" in expected:
            check(checks, "publication_count", after.get("publication_count") == expected["publication_count"])
        if "private_marker_in_publication" in expected:
            check(checks, "private_marker_not_published", after.get("private_marker_in_publication") == expected["private_marker_in_publication"])
        if expected.get("publication_count"):
            check(checks, "public_sink_value_sanitized", after.get("public_value_only") is True)
        runtime_expected = expected.get("runtime")
        if runtime_expected:
            if isinstance(runtime_evidence, dict):
                assert_runtime(checks, runtime_expected, runtime_evidence)
    return report(checks)


def assert_runtime(checks: dict[str, bool], expected: dict[str, Any], runtime: dict[str, Any]) -> None:
    if expected.get("denied"):
        check(checks, "runtime_denied", runtime.get("denied") is True)
        assert_denial_receipts(checks, runtime, runtime.get("call_bindings"))
    if expected.get("sanitized"):
        check(checks, "runtime_sanitized", runtime.get("sanitized") is True)
    if expected.get("fork"):
        check(checks, "fork_kind", runtime.get("root_kind") == "fork")
    if expected.get("source_scope_preserved"):
        check(checks, "fork_scope_preserved", runtime.get("source_scope_preserved") is True)
    if expected.get("compacted_same_root"):
        check(checks, "compaction_same_root", runtime.get("compacted_same_root") is True)
    if expected.get("signed_child"):
        child = runtime.get("child", {})
        check(checks, "signed_child_id", isinstance(child, dict) and child.get("signed_id") is True and isinstance(child.get("marker_sha256"), str) and len(child["marker_sha256"]) == 64)
        check(checks, "child_data_classification", isinstance(child, dict) and child.get("classification") == expected.get("child"))
    if expected.get("child_return_before_wait"):
        child = runtime.get("child", {})
        check(checks, "child_lifecycle_order", isinstance(child, dict) and child.get("return_before_wait") is True and child.get("scope_preserved") is True)
    if expected.get("approval"):
        approval = runtime.get("approval", {})
        check(checks, "only_automated_test_reviewer", isinstance(approval, dict) and approval.get("actor_kind") == expected["approval"])
    if "approval_effect_count" in expected:
        approval = runtime.get("approval", {})
        check(checks, "approved_once", isinstance(approval, dict) and approval.get("effect_count") == expected["approval_effect_count"])
    if "replay_status" in expected:
        approval = runtime.get("approval", {})
        check(checks, "replay_refused", isinstance(approval, dict) and approval.get("replay_status") == expected["replay_status"])
    if "denial_basis" in expected:
        receipts = runtime.get("denial_receipts")
        check(checks, "policy_audience_denial", isinstance(receipts, list) and bool(receipts) and all(isinstance(receipt, dict) and receipt.get("basis") == expected["denial_basis"] for receipt in receipts))


def check(checks: dict[str, bool], name: str, value: bool) -> None:
    checks[name] = value


def assert_client_provenance(checks: dict[str, bool], result: dict[str, Any]) -> None:
    provenance = result.get("client_provenance", {})
    check(checks, "stock_client_provenance_verified", isinstance(provenance, dict) and provenance.get("provenance_verified") is True)
    check(checks, "stock_client_version_verified", isinstance(provenance, dict) and provenance.get("observed_version") == provenance.get("expected_version"))
    check(checks, "stock_client_digest_archived", isinstance(provenance, dict) and isinstance(provenance.get("sha256"), str) and len(provenance["sha256"]) == 64)
    check(checks, "stock_client_resolved_path_archived", isinstance(provenance, dict) and isinstance(provenance.get("resolved_path"), str) and bool(provenance["resolved_path"]))


def assert_configuration_fingerprint(checks: dict[str, bool], result: dict[str, Any]) -> None:
    configuration = result.get("configuration", {})
    sanitized = configuration.get("sanitized") if isinstance(configuration, dict) else None
    check(checks, "sanitized_configuration_fingerprint", isinstance(configuration, dict) and isinstance(configuration.get("sha256"), str) and len(configuration["sha256"]) == 64 and isinstance(sanitized, dict) and isinstance(sanitized.get("argv"), list) and is_hash(sanitized.get("argv_sha256")))
    check(checks, "configuration_excludes_secret_values", isinstance(sanitized, dict) and not contains_secret_key(sanitized))


def assert_evidence_contract(checks: dict[str, bool], runtime: dict[str, Any], client: str) -> None:
    linkage = runtime.get("linkage", {})
    required_linkage = (
        "linked",
        "owner_bound_session",
        "server_client_identity",
        "interaction",
        "archestra_call",
        "archestra_settled_event",
        "authorized_dispatch_receipt",
        "provider_hosted_mcp_rejected",
        "runtime_journal",
        "runtime_request_key",
        "fixture_exact_call_join",
        "gateway_tool_receipt",
    )
    check(checks, "native_enforcement_linkage", isinstance(linkage, dict) and all(linkage.get(name) is True for name in required_linkage))
    bindings = runtime.get("call_bindings")
    check(checks, "exact_call_bindings_present", isinstance(bindings, list) and bool(bindings) and all(valid_call_binding(item) for item in bindings))
    archestra = runtime.get("archestra", {})
    check(checks, "no_cross_root_evidence", isinstance(archestra, dict) and archestra.get("root_count") == 1)
    check(checks, "server_identity_matches_selected_stock_client", runtime.get("server_binding") == EXPECTED_BACKEND_IDENTITIES.get(client))
    check(checks, "collector_fixture_exact_join", isinstance(runtime.get("fixture_join"), dict) and runtime["fixture_join"].get("matched") is True)
    check(checks, "collector_gateway_receipt_join", isinstance(runtime.get("gateway_join"), dict) and runtime["gateway_join"].get("matched") is True)
    if isinstance(bindings, list) and any(isinstance(binding, dict) and binding.get("state") == "denied" for binding in bindings):
        assert_denial_receipts(checks, runtime, bindings)


def assert_fixture_evidence(checks: dict[str, bool], result: dict[str, Any], runtime: dict[str, Any]) -> None:
    evidence = result.get("fixture_evidence")
    before = result.get("fixture_before", {})
    after = result.get("fixture_after", {})
    bindings = runtime.get("call_bindings") if isinstance(runtime.get("call_bindings"), list) else []
    check(checks, "fixture_trusted_observer_present", isinstance(evidence, dict) and evidence.get("collector_status") is None and evidence.get("source") == "trusted-fixture-audit/v1")
    if not isinstance(evidence, dict):
        return
    check(checks, "fixture_observer_scoped_to_run", isinstance(result.get("run_id"), str) and evidence.get("run_id") == result.get("run_id"))
    check(checks, "fixture_effects_start_after_empty_run", isinstance(before, dict) and before.get("audit_count") == 0 and before.get("publication_count") == 0)
    fixture_bindings = evidence.get("call_bindings")
    check(checks, "fixture_audit_count_matches_observed_state", isinstance(after, dict) and evidence.get("audit_record_count") == after.get("audit_count"))
    check(checks, "fixture_bindings_have_trusted_ordering", isinstance(fixture_bindings, list) and bool(fixture_bindings) and all(valid_fixture_binding(item) for item in fixture_bindings))
    check(checks, "fixture_bindings_share_service_instance", isinstance(fixture_bindings, list) and isinstance(evidence.get("service_instance_id"), str) and all(isinstance(item, dict) and item.get("service_instance_id") == evidence["service_instance_id"] for item in fixture_bindings))
    if not isinstance(fixture_bindings, list):
        return
    expected = {
        (item.get("target_name"), item.get("arguments_sha256"))
        for item in bindings
        if isinstance(item, dict) and item.get("state") != "denied"
    }
    observed = {
        (item.get("tool_name"), item.get("arguments_sha256"))
        for item in fixture_bindings
        if isinstance(item, dict)
    }
    check(checks, "fixture_calls_match_authorized_backend_receipts", bool(expected) and observed == expected)
    assert_phase_trace_contract(checks, bindings, fixture_bindings, runtime)


def assert_phase_trace_contract(checks: dict[str, bool], bindings: list[Any], fixture_bindings: list[Any], runtime: dict[str, Any]) -> None:
    traces = runtime.get("phase_traces")
    if not isinstance(traces, dict):
        check(checks, "per_call_phase_trace", False)
        return
    groups = {
        "authorization_receipts": ("backend-runtime-receipt/v1", "persisted_at", "authorization_receipt"),
        "proposal_deliveries": ("backend-socket-write/v1", "write_finished_at", "proposal_socket_write_finish"),
        "result_admissions": ("backend-runtime-receipt/v1", "persisted_at", "result_admission_receipt"),
        "result_releases": ("backend-socket-write/v1", "write_finished_at", "continuation_socket_write_finish"),
    }
    valid = True
    for call in bindings:
        if not isinstance(call, dict) or call.get("state") == "denied":
            continue
        call_id = call.get("call_id_sha256")
        matching_fixture = [item for item in fixture_bindings if isinstance(item, dict) and item.get("tool_name") == call.get("target_name") and item.get("arguments_sha256") == call.get("arguments_sha256")]
        timestamps: list[dt.datetime] = []
        for group, (source, timestamp_key, phase) in groups.items():
            records = traces.get(group)
            matches = [item for item in records if isinstance(item, dict) and item.get("call_id_sha256") == call_id and item.get("source") == source and item.get("phase") == phase and is_hash(item.get("trace_id_sha256")) and parse_timestamp(item.get(timestamp_key)) is not None] if isinstance(records, list) else []
            if len(matches) != 1:
                valid = False
                continue
            timestamps.append(parse_timestamp(matches[0][timestamp_key]))
        if len(matching_fixture) != 1 or not timestamps:
            valid = False
            continue
        fixture_at = parse_timestamp(matching_fixture[0].get("invoked_at"))
        valid = valid and fixture_at is not None and len(timestamps) == 4 and timestamps[0] <= timestamps[1] <= fixture_at <= timestamps[2] <= timestamps[3]
    check(checks, "per_call_phase_trace", valid)


def valid_call_binding(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("state") == "denied":
        return all(is_hash(value.get(name)) for name in ("call_row_id_sha256", "call_id_sha256", "proxy_session_id_sha256", "bound_auth_scope_hash", "arguments_sha256")) and isinstance(value.get("target_name"), str)
    return isinstance(value.get("emitted_name"), str) and all(is_hash(value.get(name)) for name in ("call_id_sha256", "dispatch_id_sha256", "emitted_arguments_sha256", "arguments_sha256")) and all(valid_phase_receipt(value.get(name), event, decision) for name, event, decision in (("authorization_receipt", "tool_calls", "allow_calls"), ("result_admission_receipt", "tool_result", "result_admitted"))) and parse_persisted_timestamp(value.get("authorization_at"))


def valid_phase_receipt(value: Any, event: str, decision: str) -> bool:
    return isinstance(value, dict) and value.get("event") == event and value.get("decision") == decision and is_hash(value.get("runtime_receipt_id_sha256")) and is_hash(value.get("runtime_receipt_sha256")) and parse_timestamp(value.get("settled_at")) is not None


def assert_denial_receipts(checks: dict[str, bool], runtime: dict[str, Any], bindings: object) -> None:
    check(checks, "exact_denial_receipts", has_exact_denial_receipts(runtime, bindings))


def has_exact_denial_receipts(runtime: dict[str, Any], bindings: object = None) -> bool:
    receipts = runtime.get("denial_receipts")
    event_receipts = runtime.get("event_receipts")
    candidate_bindings = bindings if isinstance(bindings, list) else runtime.get("call_bindings")
    denied = [binding for binding in candidate_bindings if isinstance(binding, dict) and binding.get("state") == "denied"] if isinstance(candidate_bindings, list) else []
    expected = {
        (binding.get("call_row_id_sha256"), binding.get("call_id_sha256"), binding.get("proxy_session_id_sha256"), binding.get("bound_auth_scope_hash"), binding.get("target_name"), binding.get("arguments_sha256"))
        for binding in denied
    }
    observed = {
        (receipt.get("call_row_id_sha256"), receipt.get("call_id_sha256"), receipt.get("proxy_session_id_sha256"), receipt.get("bound_auth_scope_hash"), receipt.get("target_name"), receipt.get("arguments_sha256"))
        for receipt in receipts
        if isinstance(receipt, dict)
    } if isinstance(receipts, list) else set()
    return isinstance(receipts, list) and isinstance(event_receipts, list) and bool(denied) and len(expected) == len(denied) and len(observed) == len(receipts) and expected == observed and all(valid_denial_receipt(receipt) and exact_event_receipt_match(receipt, event_receipts) for receipt in receipts)


def valid_denial_receipt(value: Any) -> bool:
    return isinstance(value, dict) and value.get("decision") == "deny_call" and value.get("basis") == "readers_not_public" and value.get("binding_provenance") == "event-call-intent/v1" and isinstance(value.get("target_name"), str) and all(is_hash(value.get(name)) for name in ("call_row_id_sha256", "call_id_sha256", "proxy_session_id_sha256", "bound_auth_scope_hash", "arguments_sha256", "event_id_sha256", "request_sha256", "response_sha256", "feedback_sha256")) and parse_persisted_timestamp(value.get("settled_at"))


def exact_event_receipt_match(receipt: dict[str, Any], events: list[Any]) -> bool:
    matches = [
        event
        for event in events
        if isinstance(event, dict)
        and event.get("event_id_sha256") == receipt.get("event_id_sha256")
        and event.get("request_sha256") == receipt.get("request_sha256")
        and event.get("response_sha256") == receipt.get("response_sha256")
        and event.get("settled_at") == receipt.get("settled_at")
        and event.get("event") == "tool_calls"
        and event.get("decision") == "deny_calls"
    ]
    return len(matches) == 1


def policy_decision_exit_matches(scenario: dict[str, Any], runtime: object) -> bool:
    return (
        scenario.get("client_exit_contract") == "policy-decision"
        and isinstance(runtime, dict)
        and runtime.get("denied") is True
        and has_exact_denial_receipts(runtime)
    )


def parse_persisted_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def valid_fixture_binding(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    required_hashes = ("arguments_sha256", "source_host_sha256", "result_sha256")
    if not isinstance(value.get("tool_name"), str) or value.get("result_status") != "result_ready" or not all(is_hash(value.get(name)) for name in required_hashes):
        return False
    if not isinstance(value.get("invocation_id"), str) or not isinstance(value.get("service_instance_id"), str):
        return False
    observed_at = parse_timestamp(value.get("invoked_at"))
    completed_at = parse_timestamp(value.get("result_at"))
    effect_at = value.get("effect_committed_at")
    effect_timestamp = parse_timestamp(effect_at) if effect_at is not None else None
    sequences = (value.get("invocation_sequence"), value.get("invoked_sequence"), value.get("effect_committed_sequence"), value.get("result_sequence"))
    return observed_at is not None and completed_at is not None and observed_at <= completed_at and (effect_timestamp is None or observed_at <= effect_timestamp <= completed_at) and isinstance(sequences[0], int) and isinstance(sequences[1], int) and isinstance(sequences[3], int) and (sequences[2] is None or isinstance(sequences[2], int))


def parse_timestamp(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def is_hash(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def contains_secret_key(value: Any) -> bool:
    if isinstance(value, dict):
        return any(any(token in str(key).lower() for token in ("key", "token", "secret", "authorization", "password")) or contains_secret_key(item) for key, item in value.items())
    if isinstance(value, list):
        return any(contains_secret_key(item) for item in value)
    return False


def report(checks: dict[str, bool]) -> int:
    failed = sorted(name for name, value in checks.items() if not value)
    print(json.dumps({"checks": checks, "passed": len(checks) - len(failed), "failed": failed}, sort_keys=True))
    return 0 if not failed else 1


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise SystemExit(f"expected JSON object: {path}")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
