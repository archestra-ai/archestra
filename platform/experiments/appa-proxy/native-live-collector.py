#!/usr/bin/env python3
"""Collect bounded read-only APPA evidence from Kubernetes runtime and PostgreSQL.

Only fixed SQL and fixed SQLite queries are executed. Raw request bodies,
history, receipts, credentials, tool arguments, and identities never leave the
queried containers or this process. Missing tables, ambiguous pods, or missing
joins are failures, never substituted evidence.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any
from uuid import UUID


RUNTIME_SQLITE_PROGRAM = r'''
import json, sqlite3, sys
db_path, request_key, *roots = sys.argv[1:]
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
if not {"logs", "checkpoints"}.issubset(tables):
    raise SystemExit("runtime journal schema is incomplete")
rows = connection.execute(
    "SELECT root, seq, facts FROM logs WHERE root IN (%s) ORDER BY root, seq" % ",".join("?" for _ in roots), roots
).fetchall()
facts = [str(row[2]).lower() for row in rows]
joined = "\n".join(facts)
return_positions = [index for index, fact in enumerate(facts) if "child_return" in fact]
wait_positions = [index for index, fact in enumerate(facts) if "wait_result" in fact]
checkpoint_count = connection.execute(
    "SELECT COUNT(*) FROM checkpoints WHERE source_root IN (%s)" % ",".join("?" for _ in roots), roots
).fetchone()[0]
print(json.dumps({
    "journal_root_count": len({row[0] for row in rows}),
    "journal_record_count": len(rows),
    "request_key_hits": sum(request_key in fact for fact in facts),
    "checkpoint_count": checkpoint_count,
    "gate_denied": "deny_call" in joined or "denied" in joined,
    "gate_allowed": "allow_call" in joined or "admitted" in joined,
    "child_start": "child_start" in joined,
    "child_return": "child_return" in joined,
    "wait_result": "wait_result" in joined,
    "child_return_before_wait": bool(return_positions and wait_positions and min(return_positions) < min(wait_positions)),
    "signed_marker": "spm_" in joined,
    "compaction": "compact" in joined,
    "fork": "fork" in joined,
    "approval": "approval" in joined or "review" in joined,
}))
'''

# Runtime receipts are written by the Node proxy with this exact recursive JSON
# canonicalization. PostgreSQL JSONB is semantic storage, so Python must not
# substitute its own JSON encoder when validating a receipt later.
NODE_RECEIPT_SHA256_PROGRAM = r'''
const { createHash } = require("node:crypto");
const fs = require("node:fs");

const value = JSON.parse(fs.readFileSync(0, "utf8"));

function stableStringify(item) {
  if (item === null || typeof item !== "object") return JSON.stringify(item);
  if (Array.isArray(item)) return `[${item.map(stableStringify).join(",")}]`;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(item[key])}`)
    .join(",")}}`;
}

process.stdout.write(
  createHash("sha256").update(stableStringify(value)).digest("hex"),
);
'''

POSTGRES_SQL = r'''
WITH relevant_sessions AS (
  SELECT s.id, s.root_id, s.client_session_id, s.state, s.parent_session_id,
          s.provider, s.protocol, s.model, s.owner_scope_hash
  FROM appa_proxy_sessions s
  WHERE s.profile_id = :'agent_id'::uuid
    AND s.provider = :'provider'
    AND s.protocol = :'protocol'
    AND s.model = :'model'
    AND EXISTS (
      SELECT 1 FROM appa_proxy_calls c
      WHERE c.session_id = s.id
        AND c.appa_target_arguments ->> 'request_key' = :'request_key'
        AND c.appa_target_arguments ->> 'run_id' = :'run_id'
    )
), relevant_calls AS (
  SELECT c.*, s.root_id, s.client_session_id, s.owner_scope_hash
  FROM appa_proxy_calls c
  JOIN relevant_sessions s ON s.id = c.session_id
  WHERE c.appa_target_arguments ->> 'request_key' = :'request_key'
    AND c.appa_target_arguments ->> 'run_id' = :'run_id'
), call_bindings AS (
  SELECT c.id,
         c.call_id,
          c.session_id AS proxy_session_id,
         c.emitted_name,
         c.appa_target_name,
         c.state,
          c.dispatch_id,
          encode(sha256(convert_to(c.client_session_id::text, 'UTF8')), 'hex') AS session_id_sha256,
          c.owner_scope_hash AS bound_auth_scope_hash,
         encode(sha256(convert_to(c.emitted_arguments_canonical::text, 'UTF8')), 'hex') AS emitted_arguments_sha256,
         c.appa_target_arguments AS target_arguments,
         f.execution_event_id,
         f.receipt_hash,
         c.created_at AS authorization_at,
         f.completed_at AS receipt_at,
         e.settled_at AS event_settled_at
  FROM relevant_calls c
  LEFT JOIN appa_proxy_wire_frames f
    ON f.session_id = c.session_id
   AND f.control_call_id = c.call_id
   AND f.kind = 'remedy_control'
   AND f.protocol = 'native-mcp-execution/v1'
  LEFT JOIN appa_proxy_events e
    ON e.session_id = c.session_id
   AND e.event_id = f.execution_event_id
  ORDER BY c.created_at, c.call_id
), interaction_bindings AS (
  SELECT i.id
  FROM interactions i
  JOIN relevant_sessions s ON s.client_session_id = i.session_id
  WHERE i.profile_id = :'agent_id'::uuid
    AND i.type = :'interaction_type'
    AND i.model = :'model'
)
SELECT json_build_object(
  'roots', COALESCE((SELECT json_agg(root_id ORDER BY root_id) FROM relevant_sessions), '[]'::json),
  'session_count', (SELECT count(*) FROM relevant_sessions),
  'root_count', (SELECT count(DISTINCT root_id) FROM relevant_sessions),
  'child_session_count', (SELECT count(*) FROM relevant_sessions WHERE parent_session_id IS NOT NULL),
  'call_count', (SELECT count(*) FROM relevant_calls),
  'interaction_count', (SELECT count(*) FROM interaction_bindings),
  'provider_hosted_mcp_declaration_count', (
    SELECT count(*)
    FROM interactions i
    JOIN relevant_sessions s ON s.client_session_id = i.session_id
    WHERE i.profile_id = :'agent_id'::uuid
      AND jsonb_path_exists(i.request, '$.tools[*] ? (@.type == "mcp")')
  ),
  'checkpoint_binding_count', (SELECT count(*) FROM appa_proxy_checkpoint_bindings b JOIN relevant_sessions s ON s.id = b.source_session_id),
  'denied_call_count', (SELECT count(*) FROM relevant_calls WHERE state = 'denied'),
  'unsanitized_result_count', (SELECT count(*) FROM relevant_calls WHERE result_presentation ILIKE '%SYNTHETIC_PRIVATE_NOTE%'),
  'server_binding', (SELECT json_build_object('provider', provider, 'protocol', protocol, 'model', model) FROM relevant_sessions LIMIT 1),
   'event_receipts', COALESCE((SELECT json_agg(json_build_object(
     'session_id', e.session_id,
     'event_id', e.event_id,
     'event_id_sha256', encode(sha256(convert_to(e.event_id::text, 'UTF8')), 'hex'),
     'request_body', e.request_body,
     'request_sha256', e.request_sha256,
    'response', e.response,
    'event', e.event,
    'decision', e.response -> 'decision' ->> 'decision',
    'settled_at', e.settled_at
  ) ORDER BY e.created_at) FROM appa_proxy_events e JOIN relevant_sessions s ON s.id = e.session_id), '[]'::json),
   'call_bindings', COALESCE((SELECT json_agg(json_build_object(
     'id', id,
     'call_id', call_id,
     'call_id_sha256', encode(sha256(convert_to(call_id::text, 'UTF8')), 'hex'),
     'proxy_session_id', proxy_session_id,
    'dispatch_id_sha256', CASE WHEN dispatch_id IS NULL THEN NULL ELSE encode(sha256(convert_to(dispatch_id::text, 'UTF8')), 'hex') END,
    'session_id_sha256', session_id_sha256,
    'bound_auth_scope_hash', bound_auth_scope_hash,
    'emitted_name', emitted_name,
    'target_name', appa_target_name,
    'emitted_arguments_sha256', emitted_arguments_sha256,
    'target_arguments', target_arguments,
    'state', state,
    'runtime_event_id_sha256', CASE WHEN execution_event_id IS NULL THEN NULL ELSE encode(sha256(convert_to(execution_event_id::text, 'UTF8')), 'hex') END,
    'receipt_sha256', receipt_hash,
    'authorization_at', authorization_at,
    'receipt_at', receipt_at,
    'event_settled_at', event_settled_at
  ) ORDER BY authorization_at, call_id) FROM call_bindings), '[]'::json)
);
'''

EXPECTED_BACKEND_IDENTITIES = {
    "claude": {"provider": "anthropic", "protocol": "anthropic-messages", "model": "claude-haiku-4-5", "interaction_type": "anthropic:messages"},
    "codex": {"provider": "openai", "protocol": "openai-responses", "model": "gpt-5.4", "interaction_type": "openai:responses"},
    "opencode": {"provider": "kimi", "protocol": "openai-chat-completions", "model": "kimi-for-coding", "interaction_type": "kimi:chatCompletions"},
}
FIXTURE_TOOL_NAMES = {"read_source", "publish", "protected_publish"}

REVIEW_AUDIT_PROGRAM = r'''
import hashlib, json, sys
path, review_id, expected_actor_hash = sys.argv[1:]
matches = []
with open(path, encoding="utf-8") as handle:
    for line in handle:
        record = json.loads(line)
        if record.get("review_id") == review_id:
            matches.append(record)
actor_matches = [record for record in matches if record.get("authenticated_reviewer_id") and hashlib.sha256(str(record["authenticated_reviewer_id"]).encode()).hexdigest() == expected_actor_hash]
print(json.dumps({"matching_review_count": len(matches), "test_reviewer_match_count": len(actor_matches), "approved_count": sum(record.get("decision") == "approve" for record in actor_matches), "denied_count": sum(record.get("decision") == "deny" for record in actor_matches)}))
'''


def main() -> int:
    args = parse_args()
    require_collector_configuration(args)
    validate_uuid(args.agent_id, "--agent-id")
    validate_identifier(args.request_key, "--request-key")
    validate_identifier(args.run_id, "--run-id")
    runtime_pod = single_pod(args.kubectl, args.kubectl_context, args.runtime_namespace, args.runtime_selector)
    postgres_pod = single_pod(args.kubectl, args.kubectl_context, args.pg_namespace, args.pg_selector)
    postgres = postgres_evidence(args, postgres_pod)
    gateway_profile = read_gateway_profile(args.gateway_profile) if args.gateway_profile else None
    gateway = gateway_evidence(args, postgres_pod, gateway_profile) if gateway_profile else {"bindings": []}
    roots = [str(root) for root in postgres.pop("roots", []) if isinstance(root, str)]
    if not roots:
        raise SystemExit("backend collector found no owner-bound APPA root for this run")
    candidates = sorted({*roots, *(f"kagent:{root}" for root in roots)})
    runtime = runtime_evidence(args, runtime_pod, candidates)
    review = review_evidence(args, runtime_pod)
    fixture = read_fixture_evidence(args.fixture_evidence) if args.fixture_evidence else None
    evidence = project(args, runtime_pod, postgres_pod, postgres, runtime, review, roots, fixture, gateway)
    print(json.dumps(evidence, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect safe APPA native live evidence with fixed read-only queries")
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--client", required=True, choices=["claude", "codex", "opencode"])
    parser.add_argument("--request-key", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--fixture-evidence", type=Path)
    parser.add_argument("--gateway-profile", type=Path)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--kubectl", default=os.environ.get("APPA_NATIVE_LIVE_KUBECTL", "kubectl"))
    parser.add_argument("--kubectl-context", default=os.environ.get("APPA_NATIVE_LIVE_KUBECTL_CONTEXT"))
    parser.add_argument("--runtime-namespace", default=os.environ.get("APPA_NATIVE_LIVE_RUNTIME_NAMESPACE"))
    parser.add_argument("--runtime-selector", default=os.environ.get("APPA_NATIVE_LIVE_RUNTIME_SELECTOR"))
    parser.add_argument("--runtime-container", default=os.environ.get("APPA_NATIVE_LIVE_RUNTIME_CONTAINER"))
    parser.add_argument("--runtime-db-path", default=os.environ.get("APPA_NATIVE_LIVE_RUNTIME_DB_PATH"))
    parser.add_argument("--review-id")
    parser.add_argument("--test-reviewer-id-sha256")
    parser.add_argument("--review-audit-container", default=os.environ.get("APPA_NATIVE_LIVE_REVIEW_AUDIT_CONTAINER"))
    parser.add_argument("--review-audit-path", default=os.environ.get("APPA_NATIVE_LIVE_REVIEW_AUDIT_PATH"))
    parser.add_argument("--pg-namespace", default=os.environ.get("APPA_NATIVE_LIVE_PG_NAMESPACE"))
    parser.add_argument("--pg-selector", default=os.environ.get("APPA_NATIVE_LIVE_PG_SELECTOR"))
    parser.add_argument("--pg-container", default=os.environ.get("APPA_NATIVE_LIVE_PG_CONTAINER"))
    parser.add_argument("--pg-database", default=os.environ.get("APPA_NATIVE_LIVE_PG_DATABASE"))
    parser.add_argument("--pg-user", default=os.environ.get("APPA_NATIVE_LIVE_PG_USER"))
    parser.add_argument("--pg-password-env", default="ARCHESTRA_NATIVE_LIVE_PG_PASSWORD")
    return parser.parse_args()


def single_pod(kubectl: str, context: str | None, namespace: str, selector: str) -> str:
    output = run(kubectl_prefix(kubectl, context, namespace) + ["get", "pods", "-l", selector, "-o", "json"])
    payload = json.loads(output)
    pods = [str(item["metadata"]["name"]) for item in payload.get("items", []) if item.get("status", {}).get("phase") == "Running"]
    if len(pods) != 1:
        raise SystemExit(f"expected exactly one running pod for selector {selector!r}, found {len(pods)}")
    return pods[0]


def postgres_evidence(args: argparse.Namespace, pod: str) -> dict[str, Any]:
    password = os.environ.get(args.pg_password_env)
    if not password:
        raise SystemExit(f"PostgreSQL collector requires a password in {args.pg_password_env}")
    identity = EXPECTED_BACKEND_IDENTITIES[args.client]
    query = POSTGRES_SQL
    for key, value in {
        "agent_id": args.agent_id,
        "request_key": args.request_key,
        "run_id": args.run_id,
        **identity,
    }.items():
        query = query.replace(f":'{key}'", f"'{value}'")
    command = kubectl_prefix(args.kubectl, args.kubectl_context, args.pg_namespace) + ["exec", pod, "-c", args.pg_container, "--", "env", f"PGPASSWORD={password}", "psql", "-Xq", "-v", "ON_ERROR_STOP=1", "-At", "-U", args.pg_user, "-d", args.pg_database, "-c", "BEGIN TRANSACTION READ ONLY; " + query + " COMMIT;"]
    output = run(command)
    try:
        value = json.loads(output.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as error:
        raise SystemExit("PostgreSQL collector did not return a JSON evidence object") from error
    if not isinstance(value, dict):
        raise SystemExit("PostgreSQL collector returned an invalid evidence object")
    return value


def runtime_evidence(args: argparse.Namespace, pod: str, roots: list[str]) -> dict[str, Any]:
    command = kubectl_prefix(args.kubectl, args.kubectl_context, args.runtime_namespace) + ["exec", pod, "-c", args.runtime_container, "--", "python3", "-c", RUNTIME_SQLITE_PROGRAM, args.runtime_db_path, args.request_key, *roots]
    output = run(command)
    try:
        value = json.loads(output)
    except json.JSONDecodeError as error:
        raise SystemExit("runtime journal collector did not return JSON") from error
    if not isinstance(value, dict):
        raise SystemExit("runtime journal collector returned an invalid evidence object")
    return value


def review_evidence(args: argparse.Namespace, pod: str) -> dict[str, Any] | None:
    if not args.review_id:
        return None
    if not args.test_reviewer_id_sha256 or not re.fullmatch(r"[0-9a-f]{64}", args.test_reviewer_id_sha256):
        raise SystemExit("review collection requires --test-reviewer-id-sha256")
    command = kubectl_prefix(args.kubectl, args.kubectl_context, args.runtime_namespace) + ["exec", pod, "-c", args.review_audit_container, "--", "python3", "-c", REVIEW_AUDIT_PROGRAM, args.review_audit_path, args.review_id, args.test_reviewer_id_sha256]
    output = run(command)
    try:
        value = json.loads(output)
    except json.JSONDecodeError as error:
        raise SystemExit("review audit collector did not return JSON") from error
    if not isinstance(value, dict):
        raise SystemExit("review audit collector returned an invalid evidence object")
    return value


def project(args: argparse.Namespace, runtime_pod: str, postgres_pod: str, postgres: dict[str, Any], runtime: dict[str, Any], review: dict[str, Any] | None, roots: list[str], fixture: dict[str, Any] | None, gateway: dict[str, Any]) -> dict[str, Any]:
    expected_identity = EXPECTED_BACKEND_IDENTITIES[args.client]
    bindings = postgres.get("call_bindings") if isinstance(postgres.get("call_bindings"), list) else []
    exact_bindings = [project_call_binding(binding, gateway.get("tool_names")) for binding in bindings if isinstance(binding, dict)]
    exact_bindings = [binding for binding in exact_bindings if binding is not None]
    denial_receipts = project_denial_receipts(bindings, postgres.get("event_receipts"), gateway.get("tool_names"))
    denied_bindings = [binding for binding in exact_bindings if binding.get("state") == "denied"]
    accepted_bindings = [
        binding
        for binding in exact_bindings
        if binding.get("state") != "denied"
        and isinstance(binding.get("dispatch_id_sha256"), str)
        and isinstance(binding.get("runtime_event_id_sha256"), str)
        and isinstance(binding.get("receipt_sha256"), str)
        and binding.get("receipt_at") is not None
    ]
    dispatched_bindings = [
        binding
        for binding in exact_bindings
        if binding.get("state") != "denied" and isinstance(binding.get("dispatch_id_sha256"), str)
    ]
    linked = (
        postgres.get("root_count") == 1
        and bool(postgres.get("interaction_count"))
        and bool(exact_bindings)
        and len(exact_bindings) == len(bindings)
        and bool(runtime.get("journal_record_count"))
        and bool(runtime.get("request_key_hits"))
    )
    fixture_join = exact_fixture_join(args.run_id, dispatched_bindings, fixture)
    gateway_join = exact_gateway_join(dispatched_bindings, gateway)
    child = {
        "classification": "private" if "private" in args.scenario else "public",
        "signed_id": bool(runtime.get("signed_marker")),
        "marker_sha256": sha256(f"{args.run_id}:{args.client}".encode()).hexdigest() if runtime.get("signed_marker") else None,
        "scope_preserved": postgres.get("child_session_count", 0) > 0,
        "return_before_wait": bool(runtime.get("child_return_before_wait")),
    }
    return {
        "collector": "native-live-collector/v2",
        "selectors": {
            "runtime": {"namespace": args.runtime_namespace, "selector": args.runtime_selector, "pod": sha256(runtime_pod.encode()).hexdigest()},
            "postgres": {"namespace": args.pg_namespace, "selector": args.pg_selector, "pod": sha256(postgres_pod.encode()).hexdigest()},
        },
        "linkage": {
            "owner_bound_session": postgres.get("root_count") == 1,
            "server_client_identity": postgres.get("server_binding") == {key: expected_identity[key] for key in ("provider", "protocol", "model")},
            "interaction": postgres.get("interaction_count", 0) > 0,
            "archestra_call": bool(exact_bindings),
            "archestra_settled_event": all(binding.get("event_settled_at") is not None for binding in accepted_bindings) and bool(accepted_bindings),
            "authorized_dispatch_receipt": bool(accepted_bindings),
            "exact_denial_receipts": exact_denial_receipts_match(denied_bindings, denial_receipts),
            "provider_hosted_mcp_rejected": postgres.get("provider_hosted_mcp_declaration_count", 0) == 0,
            "runtime_journal": runtime.get("journal_record_count", 0) > 0,
            "runtime_request_key": runtime.get("request_key_hits", 0) > 0,
            "fixture_exact_call_join": fixture_join["matched"] and gateway_join["matched"],
            "gateway_tool_receipt": gateway_join["matched"],
            "linked": linked,
        },
        "server_binding": postgres.get("server_binding"),
        "event_receipts": [project_event_receipt(item) for item in postgres.get("event_receipts", []) if isinstance(item, dict)],
        "call_bindings": exact_bindings,
        "denial_receipts": denial_receipts,
        "fixture_join": fixture_join,
        "gateway": gateway,
        "gateway_join": gateway_join,
        "archestra": {key: postgres.get(key, 0) for key in ("session_count", "root_count", "call_count", "checkpoint_binding_count", "interaction_count", "provider_hosted_mcp_declaration_count", "denied_call_count", "unsanitized_result_count")},
        "runtime": {key: runtime.get(key, False) for key in ("journal_root_count", "journal_record_count", "request_key_hits", "checkpoint_count", "gate_denied", "gate_allowed")},
        "denied": exact_denial_receipts_match(denied_bindings, denial_receipts),
        "sanitized": postgres.get("unsanitized_result_count", 0) == 0 and bool(exact_bindings),
        "root_kind": "fork" if bool(runtime.get("fork")) else "root",
        "source_scope_preserved": bool(runtime.get("fork")) and postgres.get("checkpoint_binding_count", 0) > 0,
        "compacted_same_root": bool(runtime.get("compaction")) and runtime.get("journal_root_count", 0) == 1,
        "child": child,
        "approval": {"actor_kind": "automated-test-reviewer" if review and review.get("test_reviewer_match_count") == 1 else None, "effect_count": review.get("approved_count", 0) if review else 0, "replay_status": 409 if args.scenario == "test-review-replay-denied" and review and review.get("test_reviewer_match_count") == 1 and bool(postgres.get("denied_call_count")) else None},
        "root_hashes": sorted(sha256(root.encode()).hexdigest() for root in roots),
        "phase_traces": {
            "authorization_receipts": [],
            "proposal_deliveries": [],
            "result_admissions": [],
            "result_releases": [],
        },
        "proof_gaps": ["current backend evidence has no per-call authorization receipt, proposal socket-write finish, result-admission receipt, or continuation socket-write finish trace"],
    }


def run(command: list[str]) -> str:
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60)
    if completed.returncode != 0:
        detail = completed.stderr[:2000]
        detail = re.sub(r"(?i)(authorization|bearer|token|password)=?\S+", r"\1=<redacted>", detail)
        raise SystemExit(f"read-only collector command failed: {command[0]}: {detail.strip()}")
    return completed.stdout


def require_collector_configuration(args: argparse.Namespace) -> None:
    required = (
        "runtime_namespace",
        "runtime_selector",
        "runtime_container",
        "runtime_db_path",
        "pg_namespace",
        "pg_selector",
        "pg_container",
        "pg_database",
        "pg_user",
    )
    missing = [f"--{name.replace('_', '-')}" for name in required if not getattr(args, name)]
    if missing:
        raise SystemExit(f"collector requires explicit deployment inputs: {', '.join(missing)}")
    if args.review_id and (not args.review_audit_container or not args.review_audit_path):
        raise SystemExit("review collection requires --review-audit-container and --review-audit-path")


def kubectl_prefix(kubectl: str, context: str | None, namespace: str) -> list[str]:
    command = [kubectl]
    if context:
        command.extend(["--context", context])
    return [*command, "-n", namespace]


def read_fixture_evidence(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("fixture observer evidence is unreadable") from error
    if not isinstance(value, dict):
        raise SystemExit("fixture observer evidence must be an object")
    return value


def read_gateway_profile(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise SystemExit("gateway profile is unavailable")
    metadata = path.stat()
    if metadata.st_uid != os.geteuid() or (metadata.st_mode & 0o777) != 0o600:
        raise SystemExit("gateway profile must be owned by the collector user with mode 0600")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("gateway profile is unreadable") from error
    if (
        not isinstance(value, dict)
        or value.get("source") != "archestra-registry-assignment/v1"
        or not isinstance(value.get("mcp_server_name"), str)
        or not isinstance(value.get("profile_id"), str)
        or not isinstance(value.get("tool_names"), dict)
    ):
        raise SystemExit("gateway profile is invalid")
    validate_uuid(value["profile_id"], "gateway profile id")
    tool_names = value["tool_names"]
    if set(tool_names) != FIXTURE_TOOL_NAMES or not all(isinstance(name, str) for name in tool_names.values()):
        raise SystemExit("gateway profile tool mapping is invalid")
    return value


def gateway_evidence(args: argparse.Namespace, pod: str, profile: dict[str, Any]) -> dict[str, Any]:
    server_name = profile["mcp_server_name"].replace("'", "''")
    password = os.environ.get(args.pg_password_env)
    if not password:
        raise SystemExit(f"PostgreSQL collector requires a password in {args.pg_password_env}")
    query = f"""
SELECT COALESCE(json_agg(json_build_object(
  'receipt_id_sha256', encode(sha256(convert_to(id::text, 'UTF8')), 'hex'),
  'tool_name', tool_call ->> 'name',
  'arguments', tool_call -> 'arguments',
  'created_at', created_at,
  'auth_method', auth_method
) ORDER BY created_at), '[]'::json)
FROM mcp_tool_calls
WHERE agent_id = '{profile['profile_id']}'::uuid
  AND mcp_server_name = '{server_name}'
  AND method = 'tools/call'
  AND tool_call -> 'arguments' ->> 'run_id' = '{args.run_id}'
  AND tool_call -> 'arguments' ->> 'request_key' = '{args.request_key}';
"""
    output = run(kubectl_prefix(args.kubectl, args.kubectl_context, args.pg_namespace) + ["exec", pod, "-c", args.pg_container, "--", "env", f"PGPASSWORD={password}", "psql", "-X", "-q", "-t", "-A", "-U", args.pg_user, "-d", args.pg_database, "-c", query])
    try:
        rows = json.loads(output.strip())
    except json.JSONDecodeError as error:
        raise SystemExit("gateway receipt query returned invalid JSON") from error
    inverse = {gateway_name: fixture_name for fixture_name, gateway_name in profile["tool_names"].items()}
    bindings = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("tool_name") not in inverse or not isinstance(row.get("arguments"), dict):
            continue
        bindings.append({"receipt_id_sha256": row.get("receipt_id_sha256"), "target_name": inverse[row["tool_name"]], "arguments_sha256": sha256(canonical_json(row["arguments"]).encode()).hexdigest(), "created_at": row.get("created_at"), "auth_method": row.get("auth_method")})
    return {"mcp_server_name": profile["mcp_server_name"], "tool_names": profile["tool_names"], "bindings": bindings}


def exact_fixture_join(run_id: str, calls: list[dict[str, Any]], fixture: dict[str, Any] | None) -> dict[str, Any]:
    bindings = fixture.get("call_bindings") if isinstance(fixture, dict) else None
    if not isinstance(fixture, dict) or fixture.get("source") != "trusted-fixture-audit/v1" or fixture.get("run_id") != run_id or not isinstance(bindings, list):
        return {"matched": False, "reason": "missing-or-wrong-fixture-scope"}
    backend = {(call.get("target_name"), call.get("arguments_sha256")) for call in calls}
    observed = {(binding.get("tool_name"), binding.get("arguments_sha256")) for binding in bindings if isinstance(binding, dict)}
    if not backend or len(backend) != len(calls) or len(observed) != len(bindings) or backend != observed:
        return {"matched": False, "reason": "tool-or-canonical-argument-mismatch"}
    return {"matched": True, "binding_count": len(bindings)}


def exact_gateway_join(calls: list[dict[str, Any]], gateway: dict[str, Any]) -> dict[str, Any]:
    bindings = gateway.get("bindings") if isinstance(gateway, dict) else None
    if not isinstance(bindings, list):
        return {"matched": False, "reason": "missing-gateway-receipts"}
    backend = {(call.get("target_name"), call.get("arguments_sha256")) for call in calls}
    observed = {(binding.get("target_name"), binding.get("arguments_sha256")) for binding in bindings if isinstance(binding, dict) and isinstance(binding.get("receipt_id_sha256"), str) and isinstance(binding.get("created_at"), str)}
    if not backend or len(backend) != len(calls) or len(observed) != len(bindings) or backend != observed:
        return {"matched": False, "reason": "gateway-tool-or-argument-mismatch"}
    return {"matched": True, "receipt_count": len(bindings)}


def project_call_binding(value: dict[str, Any], gateway_tool_names: object = None) -> dict[str, Any] | None:
    target_name = fixture_tool_name(value.get("target_name"), gateway_tool_names)
    arguments = value.get("target_arguments")
    if target_name is None or not isinstance(arguments, dict):
        return None
    arguments_sha256 = sha256(canonical_json(arguments).encode()).hexdigest()
    return {
        key: value.get(key)
        for key in (
            "call_id_sha256",
            "dispatch_id_sha256",
            "session_id_sha256",
            "bound_auth_scope_hash",
            "emitted_name",
            "emitted_arguments_sha256",
            "state",
            "runtime_event_id_sha256",
            "receipt_sha256",
            "authorization_at",
            "receipt_at",
            "event_settled_at",
        )
    } | {
        "call_row_id_sha256": hash_identifier(value.get("id")),
        "proxy_session_id_sha256": hash_identifier(value.get("proxy_session_id")),
        "target_name": target_name,
        "arguments_sha256": arguments_sha256,
    }


def project_event_receipt(value: dict[str, Any]) -> dict[str, Any]:
    response = value.get("response")
    return {key: value.get(key) for key in ("event_id_sha256", "request_sha256", "event", "decision", "settled_at")} | {"response_sha256": receipt_sha256(response) if isinstance(response, dict) else None}


def project_denial_receipts(bindings: object, events: object, gateway_tool_names: object = None) -> list[dict[str, Any]]:
    """Project only uniquely-bound, settled single-call denial receipts.

    The database keeps event envelopes and responses in full so the projection
    can compare the real call ID and argument object. Neither is returned in
    evidence; only stable hashes survive this boundary.
    """
    if not isinstance(bindings, list) or not isinstance(events, list):
        return []
    receipts: list[dict[str, Any]] = []
    for binding in bindings:
        if not isinstance(binding, dict) or binding.get("state") != "denied":
            continue
        matches = [
            receipt
            for event in events
            if isinstance(event, dict)
            for receipt in [project_denial_receipt(binding, event, gateway_tool_names)]
            if receipt is not None
        ]
        if len(matches) != 1:
            return []
        receipts.extend(matches)
    return receipts


def project_denial_receipt(binding: dict[str, Any], event: dict[str, Any], gateway_tool_names: object) -> dict[str, Any] | None:
    call_id = binding.get("call_id")
    session_id = binding.get("proxy_session_id")
    bound_auth_scope_hash = binding.get("bound_auth_scope_hash")
    target_name = fixture_tool_name(binding.get("target_name"), gateway_tool_names)
    target_arguments = binding.get("target_arguments")
    response = event.get("response")
    if (
        not isinstance(call_id, str)
        or not isinstance(session_id, str)
        or not isinstance(bound_auth_scope_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", bound_auth_scope_hash)
        or target_name is None
        or not isinstance(target_arguments, dict)
        or event.get("session_id") != session_id
        or event.get("event") != "tool_calls"
        or not isinstance(event.get("event_id"), str)
        or not isinstance(event.get("request_body"), str)
        or not isinstance(event.get("request_sha256"), str)
        or not isinstance(event.get("settled_at"), str)
        or not isinstance(response, dict)
    ):
        return None
    request_body = event["request_body"]
    try:
        envelope = json.loads(request_body)
    except json.JSONDecodeError:
        return None
    if (
        sha256(request_body.encode()).hexdigest() != event["request_sha256"]
        or not isinstance(envelope, dict)
        or set(envelope) != {"event_id", "event"}
        or envelope.get("event_id") != event["event_id"]
        or not isinstance(envelope.get("event"), dict)
    ):
        return None
    proposal = envelope["event"]
    calls = proposal.get("calls")
    if (
        set(proposal) != {"event", "root_id", "calls"}
        or proposal.get("event") != "tool_calls"
        or not isinstance(calls, list)
        or len(calls) != 1
        or not isinstance(calls[0], dict)
    ):
        return None
    call = calls[0]
    if (
        set(call) != {"call_id", "tool", "arguments", "spawn"}
        or call.get("call_id") != call_id
        or fixture_tool_name(call.get("tool"), gateway_tool_names) != target_name
        or call.get("arguments") != target_arguments
    ):
        return None
    decision = response.get("decision")
    if (
        set(response) != {"protocol_version", "event_id", "request_sha256", "decision"}
        or response.get("protocol_version") != 1
        or response.get("event_id") != event["event_id"]
        or response.get("request_sha256") != event["request_sha256"]
        or not isinstance(decision, dict)
        or set(decision) != {"decision", "calls"}
        or decision.get("decision") != "deny_calls"
        or not isinstance(decision.get("calls"), list)
        or len(decision["calls"]) != 1
        or not isinstance(decision["calls"][0], dict)
    ):
        return None
    denied = decision["calls"][0]
    if (
        set(denied) != {"call_id", "decision", "feedback", "offers", "review"}
        or denied.get("call_id") != call_id
        or denied.get("decision") != "deny_call"
        or not isinstance(denied.get("feedback"), str)
        or denial_basis(denied["feedback"]) != "readers_not_public"
        or not isinstance(denied.get("offers"), list)
        or not isinstance(denied.get("review"), list)
    ):
        return None
    return {
        "call_row_id_sha256": hash_identifier(binding.get("id")),
        "call_id_sha256": hash_identifier(call_id),
        "proxy_session_id_sha256": hash_identifier(session_id),
        "bound_auth_scope_hash": bound_auth_scope_hash,
        "target_name": target_name,
        "arguments_sha256": sha256(canonical_json(target_arguments).encode()).hexdigest(),
        "event_id_sha256": hash_identifier(event["event_id"]),
        "request_sha256": event["request_sha256"],
        "response_sha256": receipt_sha256(response),
        "settled_at": event["settled_at"],
        "decision": "deny_call",
        "basis": "readers_not_public",
        "feedback_sha256": sha256(denied["feedback"].encode()).hexdigest(),
        "binding_provenance": "event-call-intent/v1",
    }


def exact_denial_receipts_match(bindings: list[dict[str, Any]], receipts: list[dict[str, Any]]) -> bool:
    if not bindings:
        return False
    expected = {
        (
            binding.get("call_row_id_sha256"),
            binding.get("call_id_sha256"),
            binding.get("proxy_session_id_sha256"),
            binding.get("bound_auth_scope_hash"),
            binding.get("target_name"),
            binding.get("arguments_sha256"),
        )
        for binding in bindings
    }
    observed = {
        (
            receipt.get("call_row_id_sha256"),
            receipt.get("call_id_sha256"),
            receipt.get("proxy_session_id_sha256"),
            receipt.get("bound_auth_scope_hash"),
            receipt.get("target_name"),
            receipt.get("arguments_sha256"),
        )
        for receipt in receipts
    }
    return len(expected) == len(bindings) and len(observed) == len(receipts) and expected == observed


def hash_identifier(value: object) -> str | None:
    return sha256(value.encode()).hexdigest() if isinstance(value, str) else None


def denial_basis(feedback: str) -> str | None:
    """Recognize only the runtime's receipt-local audience condition.

    JSON v1 has no separate policy-code field. This deliberately inspects the
    matched receipt's complete feedback, never runtime journal output or a
    cross-call aggregate.
    """
    return "readers_not_public" if re.search(r"\breaders\b.*\bnot\b.*\bpublic\b", feedback, re.IGNORECASE | re.DOTALL) else None


def fixture_tool_name(value: object, gateway_tool_names: object = None) -> str | None:
    if not isinstance(value, str):
        return None
    if isinstance(gateway_tool_names, dict):
        for fixture_name, gateway_name in gateway_tool_names.items():
            if (value == gateway_name or value.startswith("mcp/") and value.rsplit("/", 1)[-1] == gateway_name) and fixture_name in FIXTURE_TOOL_NAMES:
                return fixture_name
    if value in FIXTURE_TOOL_NAMES:
        return value
    match = re.fullmatch(r"(?:mcp__)?appa_fixture(?:__|\.)(read_source|publish|protected_publish)", value)
    return match.group(1) if match else None


def canonical_json(value: Any) -> str:
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(str(key), ensure_ascii=True)}:{canonical_json(item)}" for key, item in sorted(value.items())) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def receipt_sha256(value: dict[str, Any]) -> str:
    completed = subprocess.run(
        ["node", "-e", NODE_RECEIPT_SHA256_PROGRAM],
        input=json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        capture_output=True,
        text=True,
        timeout=10,
    )
    digest = completed.stdout.strip()
    if completed.returncode != 0 or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise SystemExit("Node receipt canonicalizer did not return a SHA-256 digest")
    return digest


def validate_uuid(value: str, label: str) -> None:
    try:
        UUID(value)
    except ValueError as error:
        raise SystemExit(f"{label} must be a UUID") from error


def validate_client_session(value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,200}", value):
        raise SystemExit("--client-session-id has invalid characters")


def validate_identifier(value: str, label: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value):
        raise SystemExit(f"{label} has invalid characters")


if __name__ == "__main__":
    raise SystemExit(main())
