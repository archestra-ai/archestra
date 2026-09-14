#!/usr/bin/env python3
"""Collect bounded read-only APPA evidence from Kubernetes runtime and PostgreSQL.

Only fixed SQL and fixed SQLite queries are executed. Raw request bodies,
history, receipts, credentials, tool arguments, and identities never leave the
queried containers or this process. Missing tables, ambiguous pods, or missing
joins are failures, never substituted evidence.
"""

from __future__ import annotations

import argparse
from collections import Counter
import datetime as dt
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
import hashlib
db_path, request_key, child_ids_json, *roots = sys.argv[1:]
try:
    child_ids = set(json.loads(child_ids_json))
except (TypeError, json.JSONDecodeError):
    raise SystemExit("child runtime identities are invalid")
if not all(isinstance(child_id, str) for child_id in child_ids):
    raise SystemExit("child runtime identities are invalid")
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
if not {"logs", "checkpoints"}.issubset(tables):
    raise SystemExit("runtime journal schema is incomplete")
rows = connection.execute(
    "SELECT root, seq, facts FROM logs WHERE root IN (%s) ORDER BY root, seq" % ",".join("?" for _ in roots), roots
).fetchall()
facts = [str(row[2]).lower() for row in rows]
joined = "\n".join(facts)
structured = []
for row in rows:
    try:
        batch = json.loads(row[2])
    except (TypeError, json.JSONDecodeError):
        continue
    if isinstance(batch, list):
        structured.extend(fact for fact in batch if isinstance(fact, dict))

def fact_payload(fact, variant):
    payload = fact.get(variant)
    return payload if isinstance(payload, dict) else None

def matching_child_ids(variant):
    matched = []
    for fact in structured:
        payload = fact_payload(fact, variant)
        if not payload:
            continue
        trajectory = payload.get("trajectory")
        if trajectory not in child_ids:
            continue
        if variant == "ChildReturn":
            return_id = payload.get("id")
            if not isinstance(return_id, dict) or return_id.get("child") != trajectory:
                continue
        matched.append(trajectory)
    return matched

def ids_with_exactly_one(identities):
    return sorted(
        hashlib.sha256(child_id.encode()).hexdigest()
        for child_id in child_ids
        if identities.count(child_id) == 1
    )

fork_opened = matching_child_ids("ForkOpened")
child_returned = matching_child_ids("ChildReturn")
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
    "child_runtime_facts": {
        "expected_child_ids_sha256": sorted(hashlib.sha256(child_id.encode()).hexdigest() for child_id in child_ids),
        "fork_opened_child_ids_sha256": ids_with_exactly_one(fork_opened),
        "child_returned_ids_sha256": ids_with_exactly_one(child_returned),
        "fact_count": len(structured),
    },
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
  SELECT s.id, s.profile_id, s.root_id, s.client_session_id, s.state, s.parent_session_id, s.parent_call_id,
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
  SELECT c.*, s.root_id, s.client_session_id, s.owner_scope_hash,
         CASE WHEN s.parent_session_id IS NULL THEN NULL ELSE s.client_session_id END AS child_actor_id
  FROM appa_proxy_calls c
  JOIN relevant_sessions s ON s.id = c.session_id
   WHERE (
     (c.appa_target_arguments ->> 'request_key' = :'request_key'
      AND c.appa_target_arguments ->> 'run_id' = :'run_id')
     OR (
       c.appa_target_name = :'local_target_name'
       AND c.appa_target_arguments = :'local_arguments'::jsonb
     )
    )
), root_local_calls AS (
   SELECT c.appa_target_name, c.emitted_name, c.state,
          c.appa_target_arguments = :'local_arguments'::jsonb AS exact_arguments
   FROM appa_proxy_calls c
   JOIN relevant_sessions s ON s.id = c.session_id
   WHERE c.emitted_name = :'local_emitted_name'
), call_bindings AS (
  SELECT c.id,
         c.call_id,
          c.session_id AS proxy_session_id,
         c.emitted_name,
          c.appa_target_name,
          c.state,
          c.root_id,
          c.child_actor_id,
          c.updated_at,
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
), child_bindings AS (
  SELECT child.id AS child_session_id,
         parent.id AS parent_session_id,
         child.root_id,
         child.client_session_id AS child_client_session_id,
         parent.client_session_id AS parent_client_session_id,
         child.parent_call_id,
         child.owner_scope_hash = parent.owner_scope_hash AS same_owner_scope,
         child.profile_id = parent.profile_id AS same_profile,
         child.root_id = parent.root_id AS same_root,
         parent_call.spawn_binding IS NOT NULL
           AND parent_call.spawn_binding_consumed_at IS NOT NULL AS spawn_binding_consumed,
         parent_call.emitted_name AS parent_emitted_name,
          parent_call.appa_target_name AS parent_target_name,
          parent_call.appa_target_arguments AS parent_target_arguments,
          parent_call.dispatch_id AS parent_dispatch_id,
          (SELECT count(*) FROM appa_proxy_calls pc
           WHERE pc.session_id = parent.id AND pc.state = 'result_admitted'
             AND pc.appa_target_arguments ->> 'kind' IN ('public', 'private')) AS parent_source_count,
         parent_call.spawn_binding,
         position(
           'apc1.' || parent_call.call_id || '.'
           IN COALESCE(parent_call.emitted_arguments_canonical, '')
         ) > 0
           AND parent_call.emitted_arguments_canonical
              ~ 'apc1\.[^.[:space:]]+\.[a-f0-9]{64}\.[a-f0-9]{64}'
           AS signed_carrier_present,
         COALESCE(alias.alias_count, 0) AS alias_count,
         COALESCE(alias.matches_child, false) AS alias_matches_child,
         COALESCE(alias.consumed, false) AS alias_consumed
  FROM relevant_sessions child
  JOIN appa_proxy_sessions parent ON parent.id = child.parent_session_id
  LEFT JOIN appa_proxy_calls parent_call
    ON parent_call.session_id = parent.id
   AND parent_call.call_id = child.parent_call_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS alias_count,
           bool_and(a.child_thread_id = child.client_session_id) AS matches_child,
           bool_and(a.consumed_at IS NOT NULL) AS consumed
    FROM appa_proxy_wire_aliases a
    WHERE a.session_id = parent.id
      AND a.kind = 'task'
      AND a.source_call_id = child.parent_call_id
  ) alias ON true
  WHERE child.parent_session_id IS NOT NULL
)
-- Date-mode timestamp columns store UTC; export an explicit offset for ordering.
SELECT json_build_object(
  'roots', COALESCE((SELECT json_agg(root_id ORDER BY root_id) FROM relevant_sessions), '[]'::json),
  'session_count', (SELECT count(*) FROM relevant_sessions),
  'root_count', (SELECT count(DISTINCT root_id) FROM relevant_sessions),
  'child_session_count', (SELECT count(*) FROM relevant_sessions WHERE parent_session_id IS NOT NULL),
  'child_bindings', COALESCE((SELECT json_agg(json_build_object(
    'parent_proxy_session_id_sha256', encode(sha256(convert_to(parent_session_id::text, 'UTF8')), 'hex'),
    'child_proxy_session_id_sha256', encode(sha256(convert_to(child_session_id::text, 'UTF8')), 'hex'),
    'child_session_id', child_session_id,
    'root_id', root_id,
    'parent_client_session_id_sha256', encode(sha256(convert_to(parent_client_session_id::text, 'UTF8')), 'hex'),
    'child_client_session_id_sha256', encode(sha256(convert_to(child_client_session_id::text, 'UTF8')), 'hex'),
    'child_client_session_id', child_client_session_id,
    'parent_call_id_sha256', encode(sha256(convert_to(parent_call_id::text, 'UTF8')), 'hex'),
    'same_owner_scope', same_owner_scope,
    'same_profile', same_profile,
    'same_root', same_root,
    'spawn_binding_consumed', spawn_binding_consumed,
    'parent_emitted_name', parent_emitted_name,
    'parent_target_name', parent_target_name,
    'parent_target_arguments', parent_target_arguments,
    'parent_dispatch_id', parent_dispatch_id,
    'parent_source_count', parent_source_count,
    'spawn_binding', spawn_binding,
    'signed_carrier_present', signed_carrier_present,
    'task_alias_count', alias_count,
    'task_alias_matches_child', alias_matches_child,
    'task_alias_consumed', alias_consumed
  ) ORDER BY child_session_id) FROM child_bindings), '[]'::json),
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
   'root_local_calls', COALESCE((SELECT json_agg(json_build_object(
     'target_name', appa_target_name,
     'emitted_name', emitted_name,
     'state', state,
     'exact_arguments', exact_arguments
   ) ORDER BY emitted_name, state) FROM root_local_calls), '[]'::json),
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
    'settled_at', e.settled_at AT TIME ZONE 'UTC'
  ) ORDER BY e.created_at) FROM appa_proxy_events e JOIN relevant_sessions s ON s.id = e.session_id), '[]'::json),
   'call_bindings', COALESCE((SELECT json_agg(json_build_object(
     'id', id,
     'call_id', call_id,
     'call_id_sha256', encode(sha256(convert_to(call_id::text, 'UTF8')), 'hex'),
     'proxy_session_id', proxy_session_id,
     'root_id', root_id,
     'child_actor_id', child_actor_id,
    'dispatch_id_sha256', CASE WHEN dispatch_id IS NULL THEN NULL ELSE encode(sha256(convert_to(dispatch_id::text, 'UTF8')), 'hex') END,
    'session_id_sha256', session_id_sha256,
    'bound_auth_scope_hash', bound_auth_scope_hash,
    'emitted_name', emitted_name,
    'target_name', appa_target_name,
    'emitted_arguments_sha256', emitted_arguments_sha256,
    'target_arguments', target_arguments,
     'state', state,
     'updated_at', updated_at AT TIME ZONE 'UTC',
    'runtime_event_id_sha256', CASE WHEN execution_event_id IS NULL THEN NULL ELSE encode(sha256(convert_to(execution_event_id::text, 'UTF8')), 'hex') END,
    'receipt_sha256', receipt_hash,
    'authorization_at', authorization_at AT TIME ZONE 'UTC',
    'receipt_at', receipt_at AT TIME ZONE 'UTC',
    'event_settled_at', event_settled_at AT TIME ZONE 'UTC'
  ) ORDER BY authorization_at, call_id) FROM call_bindings), '[]'::json)
);
'''

EXPECTED_BACKEND_IDENTITIES = {
    "claude": {"provider": "anthropic", "protocol": "anthropic-messages", "model": "claude-haiku-4-5", "interaction_type": "anthropic:messages"},
    "codex": {"provider": "openai", "protocol": "openai-responses", "model": "gpt-5.4", "interaction_type": "openai:responses"},
    "opencode": {"provider": "kimi", "protocol": "openai-chat-completions", "model": "kimi-for-coding", "interaction_type": "kimi:chatCompletions"},
}
FIXTURE_TOOL_NAMES = {"read_source", "publish", "protected_publish"}
# These are the exact NATIVE_SPAWN_TOOL_MAP contracts pinned for qualifying
# runs. Never suffix-match client wire names or weaken their target binding.
NATIVE_CHILD_CONTRACTS = {
    "codex": {
        "emitted_names": {
            "multi_agent_v1.spawn_agent",
            "agents.spawn_agent",
            "collaboration.spawn_agent",
        },
        "target_name": "agent/fixture/lifecycle_child",
        "requires_signed_carrier": False,
        "task_alias_count": 1,
    },
    "claude": {
        "emitted_names": {"Agent"},
        "target_name": "agent/fixture/lifecycle_child",
        "requires_signed_carrier": True,
        "task_alias_count": 0,
    },
    "opencode": {
        "emitted_names": {"task"},
        "target_name": "agent/fixture/lifecycle_child",
        "requires_signed_carrier": True,
        "task_alias_count": 0,
    },
}

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
    local_probe = read_local_probe_contract(args.local_probe_contract, args) if args.local_probe_contract else None
    postgres = postgres_evidence(args, postgres_pod, local_probe)
    gateway_profile = read_gateway_profile(args.gateway_profile) if args.gateway_profile else None
    gateway = gateway_evidence(args, postgres_pod, gateway_profile) if gateway_profile else {"bindings": []}
    roots = [str(root) for root in postgres.pop("roots", []) if isinstance(root, str)]
    if not roots:
        raise SystemExit("backend collector found no owner-bound APPA root for this run")
    candidates = sorted({*roots, *(f"kagent:{root}" for root in roots)})
    runtime = runtime_evidence(args, runtime_pod, candidates, postgres.get("child_bindings"))
    review = review_evidence(args, runtime_pod)
    fixture = read_fixture_evidence(args.fixture_evidence) if args.fixture_evidence else None
    evidence = project(args, runtime_pod, postgres_pod, postgres, runtime, review, roots, fixture, gateway, local_probe)
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
    parser.add_argument("--local-probe-contract", type=Path)
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


def postgres_evidence(args: argparse.Namespace, pod: str, local_probe: dict[str, Any] | None = None) -> dict[str, Any]:
    password = os.environ.get(args.pg_password_env)
    if not password:
        raise SystemExit(f"PostgreSQL collector requires a password in {args.pg_password_env}")
    identity = EXPECTED_BACKEND_IDENTITIES[args.client]
    query = POSTGRES_SQL
    for key, value in {
        "agent_id": args.agent_id,
        "request_key": args.request_key,
        "run_id": args.run_id,
        "local_target_name": local_probe["target_name"] if local_probe else "__no_local_target__",
        "local_emitted_name": local_probe["emitted_name"] if local_probe else "__no_local_emitted_name__",
        "local_arguments": json.dumps(local_probe["arguments"] if local_probe else {}, sort_keys=True, separators=(",", ":")),
        **identity,
    }.items():
        query = query.replace(f":'{key}'", sql_literal(value))
    command = kubectl_prefix(args.kubectl, args.kubectl_context, args.pg_namespace) + ["exec", pod, "-c", args.pg_container, "--", "env", f"PGPASSWORD={password}", "psql", "-Xq", "-v", "ON_ERROR_STOP=1", "-At", "-U", args.pg_user, "-d", args.pg_database, "-c", "BEGIN TRANSACTION READ ONLY; " + query + " COMMIT;"]
    output = run(command)
    try:
        value = json.loads(output.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as error:
        raise SystemExit("PostgreSQL collector did not return a JSON evidence object") from error
    if not isinstance(value, dict):
        raise SystemExit("PostgreSQL collector returned an invalid evidence object")
    return value


def runtime_evidence(args: argparse.Namespace, pod: str, roots: list[str], child_bindings: object) -> dict[str, Any]:
    child_ids = [
        binding.get("child_client_session_id")
        for binding in child_bindings
        if isinstance(binding, dict) and isinstance(binding.get("child_client_session_id"), str)
    ] if isinstance(child_bindings, list) else []
    command = kubectl_prefix(args.kubectl, args.kubectl_context, args.runtime_namespace) + ["exec", pod, "-c", args.runtime_container, "--", "python3", "-c", RUNTIME_SQLITE_PROGRAM, args.runtime_db_path, args.request_key, json.dumps(child_ids), *roots]
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


def project(args: argparse.Namespace, runtime_pod: str, postgres_pod: str, postgres: dict[str, Any], runtime: dict[str, Any], review: dict[str, Any] | None, roots: list[str], fixture: dict[str, Any] | None, gateway: dict[str, Any], local_probe: dict[str, Any] | None = None) -> dict[str, Any]:
    expected_identity = EXPECTED_BACKEND_IDENTITIES[args.client]
    bindings = postgres.get("call_bindings") if isinstance(postgres.get("call_bindings"), list) else []
    exact_bindings = [project_call_binding(binding, gateway.get("tool_names"), local_probe) for binding in bindings if isinstance(binding, dict)]
    exact_bindings = [binding for binding in exact_bindings if binding is not None]
    denial_receipts = project_denial_receipts(bindings, postgres.get("event_receipts"), gateway.get("tool_names"), local_probe)
    denied_bindings = [binding for binding in exact_bindings if binding.get("state") == "denied"]
    accepted_bindings = [
        binding
        for binding in exact_bindings
        if binding.get("state") == "result_admitted"
        and isinstance(binding.get("dispatch_id_sha256"), str)
        and isinstance(binding.get("runtime_event_id_sha256"), str)
        and isinstance(binding.get("receipt_sha256"), str)
        and binding.get("receipt_at") is not None
    ]
    dispatched_bindings = [
        binding
        for binding in exact_bindings
        if binding.get("state") == "result_admitted" and isinstance(binding.get("dispatch_id_sha256"), str)
    ]
    linked = (
        postgres.get("root_count") == 1
        and bool(postgres.get("interaction_count"))
        and bool(exact_bindings)
        and len(exact_bindings) == len(bindings)
        and bool(runtime.get("journal_record_count"))
        and bool(runtime.get("request_key_hits"))
    )
    mcp_dispatched_bindings = [binding for binding in dispatched_bindings if binding.get("target_name") != "local_callback"]
    fixture_join = exact_fixture_join(args.run_id, mcp_dispatched_bindings, fixture)
    gateway_join = exact_gateway_join(mcp_dispatched_bindings, gateway)
    local_effect = project_local_effect(
        args,
        exact_bindings,
        denial_receipts,
        fixture,
        local_probe,
        postgres.get("root_local_calls"),
    )
    raw_child_bindings = postgres.get("child_bindings") if isinstance(postgres.get("child_bindings"), list) else []
    child_bindings = [
        {
            key: value
            for key, value in binding.items()
            if key
            not in {
                "child_client_session_id",
                "child_session_id",
                "root_id",
                "spawn_binding",
                "parent_target_arguments",
                "parent_dispatch_id",
            }
        }
        for binding in raw_child_bindings
        if isinstance(binding, dict)
    ]
    exact_child_bindings = [
        binding
        for binding in child_bindings
        if valid_child_attachment(args.client, binding)
    ]
    child_proxy_ids = {
        binding["child_proxy_session_id_sha256"] for binding in exact_child_bindings
    }
    child_source_reads = [
        binding
        for binding in exact_bindings
        if binding.get("proxy_session_id_sha256") in child_proxy_ids
        and binding.get("target_name") == "read_source"
        and binding.get("source_kind") in {"public", "private"}
        and binding.get("state") == "result_admitted"
    ]
    source_kinds = [binding["source_kind"] for binding in child_source_reads]
    child_denied_bindings = [
        binding
        for binding in denied_bindings
        if binding.get("proxy_session_id_sha256") in child_proxy_ids
    ]
    child_denial_receipts = [
        receipt
        for receipt in denial_receipts
        if receipt.get("proxy_session_id_sha256") in child_proxy_ids
    ]
    child_lifecycle = project_child_lifecycle(
        args.client, postgres.get("event_receipts"), raw_child_bindings
    )
    child_end = next((receipt for receipt in child_lifecycle["receipts"] if receipt["event"] == "child_end"), None)
    child_start = next((receipt for receipt in child_lifecycle["receipts"] if receipt["event"] == "child_start"), None)
    parent_id = exact_child_bindings[0]["parent_proxy_session_id_sha256"] if len(exact_child_bindings) == 1 else None
    parent_publication_is_denied = parent_publication_denied(
        exact_bindings,
        denial_receipts,
        parent_id,
        child_end.get("settled_at") if child_end and child_lifecycle["ordered"] else None,
    )
    source_admission_order = (
        child_lifecycle["ordered"]
        and len(child_source_reads) == 1
        and child_start is not None
        and child_end is not None
        and ordered_timestamps(
            child_start["settled_at"],
            child_source_reads[0].get("result_admitted_at"),
            child_end["settled_at"],
        )
    )
    child = {
        "classification": source_kinds[0] if len(source_kinds) == 1 else None,
        "source_read_count": len(source_kinds),
        "bindings": child_bindings,
        "exact_attachment": len(child_bindings) == 1 and len(exact_child_bindings) == 1,
        "scope_preserved": len(exact_child_bindings) == 1,
        # Current runtime journals do not emit ForkOpened/ChildReturn facts.
        # Acknowledged child lifecycle receipts are durable owner-bound proof.
        "runtime_opened": child_lifecycle["started"],
        "completion_admitted": child_lifecycle["completed"],
        "lifecycle_order": child_lifecycle["ordered"],
        "lifecycle_receipts": child_lifecycle["receipts"],
        "source_admission_order": source_admission_order,
        "non_void_return": child_end is not None and child_end.get("non_void_return") is True,
        "parent_spawn_presentation": project_parent_spawn_presentation(
            args.client, postgres.get("event_receipts"), raw_child_bindings,
        ),
        "parent_has_no_source": len(exact_child_bindings) == 1 and exact_child_bindings[0].get("parent_source_count") == 0,
        "return_floor_receipts": project_child_return_floor(
            args.client, postgres.get("event_receipts"), raw_child_bindings,
            child_start.get("settled_at") if child_start and child_lifecycle["ordered"] else None,
        ),
        "denied": exact_denial_receipts_match(child_denied_bindings, child_denial_receipts),
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
            "native_child_attachment": child["exact_attachment"],
            "fixture_exact_call_join": local_effect["callback_join"] if local_probe else fixture_join["matched"] and gateway_join["matched"],
            "gateway_tool_receipt": gateway_join["matched"],
            "local_policy": local_effect["policy_bound"] if local_probe else True,
            "linked": linked,
        },
        "server_binding": postgres.get("server_binding"),
        "event_receipts": [project_event_receipt(item) for item in postgres.get("event_receipts", []) if isinstance(item, dict)],
        "call_bindings": exact_bindings,
        "denial_receipts": denial_receipts,
        "fixture_join": fixture_join,
        "gateway": gateway,
        "gateway_join": gateway_join,
        "local_effect": local_effect,
        "archestra": {key: postgres.get(key, 0) for key in ("session_count", "root_count", "call_count", "checkpoint_binding_count", "interaction_count", "provider_hosted_mcp_declaration_count", "denied_call_count", "unsanitized_result_count")},
        "runtime": {key: runtime.get(key, False) for key in ("journal_root_count", "journal_record_count", "request_key_hits", "checkpoint_count", "gate_denied", "gate_allowed")},
        "denied": exact_denial_receipts_match(denied_bindings, denial_receipts),
        "parent_publication_denied": parent_publication_is_denied,
        "parent_publication_attempt_count": sum(binding.get("target_name") == "publish" and binding.get("proxy_session_id_sha256") == parent_id for binding in exact_bindings),
        "parent_publication": parent_publication_completed(
            exact_bindings, parent_id,
            child_end.get("settled_at") if child_end and child_lifecycle["ordered"] else None,
        ),
        # Marker absence cannot prove that a sanitizer was offered or executed.
        "sanitizer_proof_gap": "held-control execution and transformed-argument receipts are not projected by this collector",
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
        "proof_gaps": [
            "current backend evidence has no per-call authorization receipt, proposal socket-write finish, result-admission receipt, or continuation socket-write finish trace",
            *(["local callback evidence observes the synthetic HTTP effect, not operating-system process execution"] if local_probe else []),
        ],
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


def read_local_probe_contract(path: Path, args: argparse.Namespace) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or (path.stat().st_mode & 0o777) != 0o600:
        raise SystemExit("local probe contract must be a regular mode-0600 file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("local probe contract is unreadable") from error
    expected = {
        "claude": ("Bash", "Bash", "command"),
        "codex": ("functions.exec_command", "functions.exec_command", "cmd"),
        "opencode": ("bash", "bash", "command"),
    }[args.client]
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or value.get("mode") not in {"public-effect", "private-effect-denied"}
        or value.get("emitted_name") != expected[0]
        or value.get("target_name") != expected[1]
        or not isinstance(value.get("arguments"), dict)
        or set(value["arguments"]) != ({expected[2], "login"} if args.client == "codex" else {expected[2], "description"} if args.client == "opencode" else {expected[2]})
        or not isinstance(value["arguments"].get(expected[2]), str)
        or value["arguments"].get(expected[2]) != value.get("command")
        or (args.client == "codex" and value["arguments"].get("login") is not False)
        or (args.client == "opencode" and value["arguments"].get("description") != "Run the fixed controlled local-effect probe.")
        or not isinstance(value.get("callback_arguments"), dict)
        or value["callback_arguments"] != {
            "run_id": args.run_id,
            "request_key": args.request_key,
            "effect": "SYNTHETIC_LOCAL_PUBLIC_EFFECT",
            "probe": "fixed-node-local-probe/v1",
        }
        or not isinstance(value.get("command_sha256"), str)
        or sha256(value["command"].encode()).hexdigest() != value["command_sha256"]
    ):
        raise SystemExit("local probe contract is invalid")
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
  'created_at', created_at AT TIME ZONE 'UTC',
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
        bindings.append({"receipt_id_sha256": row.get("receipt_id_sha256"), "target_name": inverse[row["tool_name"]], "arguments_sha256": receipt_sha256(row["arguments"]), "created_at": row.get("created_at"), "auth_method": row.get("auth_method")})
    return {"mcp_server_name": profile["mcp_server_name"], "tool_names": profile["tool_names"], "bindings": bindings}


def exact_fixture_join(run_id: str, calls: list[dict[str, Any]], fixture: dict[str, Any] | None) -> dict[str, Any]:
    bindings = fixture.get("call_bindings") if isinstance(fixture, dict) else None
    if not isinstance(fixture, dict) or fixture.get("source") != "trusted-fixture-audit/v1" or fixture.get("run_id") != run_id or not isinstance(bindings, list):
        return {"matched": False, "reason": "missing-or-wrong-fixture-scope"}
    backend = Counter((call.get("target_name"), call.get("arguments_sha256")) for call in calls)
    observed = Counter(
        (binding.get("tool_name"), binding.get("arguments_sha256"))
        for binding in bindings
        if isinstance(binding, dict)
        and binding.get("tool_name") != "local_callback"
    )
    if backend != observed:
        return {"matched": False, "reason": "tool-or-canonical-argument-mismatch"}
    return {"matched": True, "binding_count": len(bindings)}


def exact_gateway_join(calls: list[dict[str, Any]], gateway: dict[str, Any]) -> dict[str, Any]:
    bindings = gateway.get("bindings") if isinstance(gateway, dict) else None
    if not isinstance(bindings, list):
        return {"matched": False, "reason": "missing-gateway-receipts"}
    backend = Counter((call.get("target_name"), call.get("arguments_sha256")) for call in calls)
    observed = Counter(
        (binding.get("target_name"), binding.get("arguments_sha256"))
        for binding in bindings
        if isinstance(binding, dict)
        and isinstance(binding.get("receipt_id_sha256"), str)
        and isinstance(binding.get("created_at"), str)
    )
    if backend != observed:
        return {"matched": False, "reason": "gateway-tool-or-argument-mismatch"}
    return {"matched": True, "receipt_count": len(bindings)}


def project_local_effect(
    args: argparse.Namespace,
    bindings: list[dict[str, Any]],
    denial_receipts: list[dict[str, Any]],
    fixture: dict[str, Any] | None,
    local_probe: dict[str, Any] | None,
    root_local_calls: object = None,
) -> dict[str, Any]:
    if local_probe is None:
        return {
            "mode": None,
            "policy_bound": True,
            "callback_join": False,
            "client_reported_result": None,
        }
    local_bindings = [binding for binding in bindings if binding.get("target_name") == "local_callback"]
    expected_source_kind = "public" if local_probe["mode"] == "public-effect" else "private"
    all_source_reads = [binding for binding in bindings if binding.get("target_name") == "read_source"]
    source_reads = [
        binding
        for binding in bindings
        if binding.get("target_name") == "read_source"
        and binding.get("state") == "result_admitted"
        and binding.get("source_kind") == expected_source_kind
    ]
    root_local = root_local_calls if isinstance(root_local_calls, list) else []
    root_local_exact = (
        len(root_local) == 1
        and isinstance(root_local[0], dict)
        and root_local[0].get("target_name") == local_probe["target_name"]
        and root_local[0].get("emitted_name") == local_probe["emitted_name"]
        and root_local[0].get("exact_arguments") is True
    )
    local_denials = [receipt for receipt in denial_receipts if receipt.get("target_name") == "local_callback"]
    accepted = [binding for binding in local_bindings if binding.get("state") == "result_admitted"]
    denied = [binding for binding in local_bindings if binding.get("state") == "denied"]
    callback_arguments_sha256 = receipt_sha256(local_probe["callback_arguments"])
    observer_bindings = fixture.get("call_bindings") if isinstance(fixture, dict) else None
    callback_bindings = [
        binding
        for binding in observer_bindings if isinstance(binding, dict)
        and binding.get("tool_name") == "local_callback"
        and binding.get("arguments_sha256") == callback_arguments_sha256
    ] if isinstance(observer_bindings, list) else []
    effect_counts = fixture.get("effect_counts") if isinstance(fixture, dict) else None
    callback_count = effect_counts.get("local_callback") if isinstance(effect_counts, dict) else None
    mode = local_probe["mode"]
    if mode == "public-effect":
        callback_join = (
            len(accepted) == 1
            and not denied
            and len(callback_bindings) == 1
            and callback_count == 1
            and valid_local_callback_binding(callback_bindings[0])
        )
        return {
            "mode": mode,
            "policy_bound": len(all_source_reads) == 1 and len(source_reads) == 1 and len(local_bindings) == 1 and len(accepted) == 1 and root_local_exact and source_precedes_local(source_reads[0], accepted[0]),
            "callback_join": callback_join,
            "callback_effect_count": callback_count,
            "callback": project_local_callback(callback_bindings[0]) if callback_join else None,
            "local_call": project_local_call(accepted[0]) if len(accepted) == 1 else None,
            "client_reported_result": {
                "provenance": "sealed-client-reported-observation",
                "state": "result_admitted",
                "not_os_process_attestation": True,
            } if len(accepted) == 1 else None,
        }
    denied_exact = exact_denial_receipts_match(denied, local_denials)
    return {
        "mode": mode,
        "policy_bound": len(all_source_reads) == 1 and len(source_reads) == 1 and len(local_bindings) == 1 and len(denied) == 1 and denied_exact and root_local_exact and source_precedes_local(source_reads[0], denied[0]),
        "callback_join": callback_count == 0 and not callback_bindings,
        "callback_effect_count": callback_count,
        "callback": None,
        "local_call": project_local_call(denied[0]) if len(denied) == 1 else None,
        "client_reported_result": None,
        "denial_receipt_count": len(local_denials),
        "root_local_call_count": len(root_local),
    }


def valid_local_callback_binding(value: dict[str, Any]) -> bool:
    sequences = (
        value.get("invocation_sequence"),
        value.get("invoked_sequence"),
        value.get("effect_committed_sequence"),
        value.get("result_sequence"),
    )
    return (
        value.get("effect_state") == "known_committed"
        and value.get("reply_state") == "known"
        and value.get("result_status") == "result_ready"
        and all(isinstance(sequence, int) for sequence in sequences)
        and sequences[0] == sequences[1] < sequences[2] < sequences[3]
        and is_sha256(value.get("arguments_sha256"))
        and is_sha256(value.get("source_host_sha256"))
        and is_sha256(value.get("result_sha256"))
        and isinstance(value.get("service_instance_id"), str)
    )


def source_precedes_local(source: dict[str, Any], local: dict[str, Any]) -> bool:
    source_settled = source.get("event_settled_at")
    local_authorized = local.get("authorization_at")
    return isinstance(source_settled, str) and isinstance(local_authorized, str) and source_settled <= local_authorized


def project_local_callback(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value.get(key)
        for key in (
            "arguments_sha256",
            "source_host_sha256",
            "result_sha256",
            "service_instance_id",
            "invocation_sequence",
            "invoked_sequence",
            "effect_committed_sequence",
            "result_sequence",
            "effect_state",
            "reply_state",
            "result_status",
        )
    }


def project_local_call(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value.get(key)
        for key in (
            "call_id_sha256",
            "dispatch_id_sha256",
            "session_id_sha256",
            "proxy_session_id_sha256",
            "bound_auth_scope_hash",
            "arguments_sha256",
            "state",
            "authorization_at",
            "receipt_at",
            "event_settled_at",
        )
    }


def project_call_binding(value: dict[str, Any], gateway_tool_names: object = None, local_probe: dict[str, Any] | None = None) -> dict[str, Any] | None:
    target_name = canonical_target_name(value.get("target_name"), gateway_tool_names, local_probe)
    arguments = value.get("target_arguments")
    if target_name is None or not isinstance(arguments, dict):
        return None
    if target_name == "local_callback" and local_probe is not None:
        if value.get("emitted_name") != local_probe["emitted_name"] or arguments != local_probe["arguments"]:
            return None
    arguments_sha256 = receipt_sha256(arguments)
    source_kind = (
        arguments.get("kind")
        if target_name == "read_source" and arguments.get("kind") in {"public", "private"}
        else None
    )
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
        "child_actor_id_sha256": hash_identifier(value.get("child_actor_id")),
        "target_name": target_name,
        "arguments_sha256": arguments_sha256,
        "source_kind": source_kind,
        "result_admitted_at": value.get("updated_at") if value.get("state") == "result_admitted" else None,
    }


def project_event_receipt(value: dict[str, Any]) -> dict[str, Any]:
    response = value.get("response")
    return {key: value.get(key) for key in ("event_id_sha256", "request_sha256", "event", "decision", "settled_at")} | {"response_sha256": receipt_sha256(response) if isinstance(response, dict) else None}


def project_child_lifecycle(
    client: str, events: object, child_bindings: object
) -> dict[str, Any]:
    if not isinstance(events, list) or not isinstance(child_bindings, list):
        return {"started": False, "completed": False, "ordered": False, "receipts": []}
    exact_bindings = [
        binding
        for binding in child_bindings
        if isinstance(binding, dict)
        and valid_child_attachment(client, binding)
        and all(
            isinstance(binding.get(field), str)
            for field in ("child_session_id", "child_client_session_id", "root_id", "spawn_binding")
        )
    ]
    if len(exact_bindings) != 1:
        return {"started": False, "completed": False, "ordered": False, "receipts": []}
    binding = exact_bindings[0]
    child_session_id = binding["child_session_id"]
    receipts = [
        event
        for event in events
        if isinstance(event, dict)
        and event.get("session_id") == child_session_id
        and event.get("event") in {"child_start", "child_end"}
        and event.get("decision") == "ack"
        and isinstance(event.get("event_id_sha256"), str)
        and isinstance(event.get("request_sha256"), str)
        and isinstance(event.get("settled_at"), str)
        and parse_event_timestamp(event["settled_at"]) is not None
        and child_lifecycle_event_matches(event, binding)
    ]
    starts = [event for event in receipts if event["event"] == "child_start"]
    ends = [event for event in receipts if event["event"] == "child_end"]
    started = len(starts) == 1
    completed = len(ends) == 1
    ordered = (
        started
        and completed
        and ordered_timestamps(starts[0]["settled_at"], ends[0]["settled_at"])
    )
    return {
        "started": started,
        "completed": completed,
        "ordered": ordered,
        "receipts": [
            project_event_receipt(event)
            | {
                "proxy_session_id_sha256": hash_identifier(child_session_id),
                "child_id_matches": True,
                "root_id_matches": True,
                "spawn_binding_matches": event["event"] == "child_start",
                "non_void_return": event["event"] == "child_end" and bool((settled_event_request(event) or {}).get("value")),
            }
            for event in receipts
        ],
    }


def child_lifecycle_event_matches(event: dict[str, Any], binding: dict[str, Any]) -> bool:
    payload = settled_event_request(event)
    if not isinstance(payload, dict):
        return False
    if (
        payload.get("event") != event.get("event")
        or payload.get("child_id") != binding.get("child_client_session_id")
        or payload.get("root_id") != binding.get("root_id")
    ):
        return False
    return event["event"] != "child_start" or payload.get("spawn_binding") == binding.get("spawn_binding")


def project_parent_spawn_presentation(client: str, events: object, bindings: object) -> dict[str, Any]:
    if not isinstance(events, list) or not isinstance(bindings, list) or len(bindings) != 1:
        return {"verified": False}
    binding = bindings[0]
    if not isinstance(binding, dict) or not valid_child_attachment(client, binding) or not isinstance(binding.get("parent_dispatch_id"), str):
        return {"verified": False}
    ends = [event for event in events if isinstance(event, dict) and event.get("event") == "child_end" and event.get("decision") == "ack" and event.get("session_id") == binding.get("child_session_id") and child_lifecycle_event_matches(event, binding)]
    if len(ends) != 1:
        return {"verified": False}
    end = ends[0]
    child_value = (settled_event_request(end) or {}).get("value")
    if not isinstance(child_value, str) or not child_value:
        return {"verified": False}
    candidates = []
    for event in events:
        if not isinstance(event, dict) or hash_identifier(event.get("session_id")) != binding["parent_proxy_session_id_sha256"]:
            continue
        request = settled_event_request(event)
        if not request or request.get("event") != "spawn_result" or hash_identifier(request.get("call_id")) != binding["parent_call_id_sha256"]:
            continue
        decision = event["response"].get("decision")
        control = request.get("control")
        if (
            not set(request).issubset({"event", "root_id", "call_id", "dispatch_id", "control"})
            or (control is not None and (not isinstance(control, dict) or set(control) != {"agent_id"} or control.get("agent_id") != binding.get("child_client_session_id")))
            or request.get("root_id") != binding.get("root_id")
            or request.get("child_id") is not None
            or request.get("dispatch_id") != binding["parent_dispatch_id"]
            or not isinstance(decision, dict) or decision.get("decision") != "result_admitted"
            or not isinstance(decision.get("presentation"), str)
        ):
            return {"verified": False}
        presentation = decision["presentation"]
        kind = None
        if ordered_timestamps(end["settled_at"], event.get("settled_at")):
            if presentation == child_value:
                kind = "child_return"
        elif ordered_timestamps(event.get("settled_at"), end["settled_at"]):
            if presentation == json.dumps({"agent_id": binding.get("child_client_session_id")}, separators=(",", ":"), ensure_ascii=False):
                kind = "control_metadata"
            elif presentation == '{"status":"unavailable"}':
                kind = "unavailable"
        if kind is None:
            return {"verified": False}
        candidates.append(project_event_receipt(event) | {
            "kind": kind,
            "parent_call_id_sha256": binding["parent_call_id_sha256"],
            "presentation_sha256": sha256(presentation.encode()).hexdigest(),
        })
    return {"verified": len(candidates) == 1, "receipts": candidates}


def project_child_return_floor(client: str, events: object, bindings: object, child_start_at: str | None) -> list[dict[str, Any]]:
    if not isinstance(events, list) or not isinstance(bindings, list) or len(bindings) != 1 or child_start_at is None:
        return []
    binding = bindings[0]
    if not isinstance(binding, dict) or not valid_child_attachment(client, binding) or not isinstance(binding.get("parent_target_arguments"), dict):
        return []
    parent_id = binding["parent_proxy_session_id_sha256"]
    arguments_sha256 = receipt_sha256(binding["parent_target_arguments"])
    offers: dict[str, str] = {}
    parent_events = [event for event in events if isinstance(event, dict) and hash_identifier(event.get("session_id")) == parent_id]
    for event in parent_events:
        request = settled_event_request(event)
        if not request or request.get("event") != "tool_calls" or request.get("root_id") != binding.get("root_id") or request.get("child_id") is not None:
            continue
        decision = event["response"].get("decision", {})
        calls = request.get("calls")
        if not isinstance(calls, list) or not any(
            isinstance(call, dict) and hash_identifier(call.get("call_id")) == binding["parent_call_id_sha256"]
            and call.get("tool") == binding["parent_target_name"] and call.get("arguments") == binding["parent_target_arguments"]
            and call.get("spawn") is True for call in calls
        ) or not isinstance(decision, dict) or decision.get("decision") != "deny_calls":
            continue
        denied_calls = decision.get("calls")
        if not isinstance(denied_calls, list):
            continue
        for call in denied_calls:
            if not isinstance(call, dict) or hash_identifier(call.get("call_id")) != binding["parent_call_id_sha256"]:
                continue
            call_offers = call.get("offers")
            if not isinstance(call_offers, list):
                continue
            for offer in call_offers:
                if isinstance(offer, dict) and isinstance(offer.get("offer_id"), str) and offer.get("kind") == "acceptance" and offer.get("tool") == binding["parent_target_name"] and offer.get("arguments_sha256") == arguments_sha256:
                    offers[offer["offer_id"]] = event["settled_at"]
    receipts = []
    for event in parent_events:
        request = settled_event_request(event)
        if not request or request.get("event") != "resolve_offer":
            continue
        decision = event["response"].get("decision", {})
        if not isinstance(decision, dict):
            continue
        offer_id = request.get("offer_id")
        if (
            not isinstance(offer_id, str) or offer_id not in offers
            or request.get("root_id") != binding.get("root_id") or request.get("child_id") is not None
            or request.get("resolution") != "accept_restriction"
            or not isinstance(request.get("label"), dict) or not request["label"]
            or request.get("tool") != binding["parent_target_name"] or request.get("arguments_sha256") != arguments_sha256
            or decision.get("decision") != "offer_resolved" or decision.get("offer_id") != offer_id
            or decision.get("kind") != "acceptance" or decision.get("resolution") != "accepted"
            or decision.get("tool") != request["tool"] or decision.get("arguments_sha256") != arguments_sha256
            or not ordered_timestamps(offers[offer_id], event.get("settled_at"), child_start_at)
        ):
            continue
        receipts.append(project_event_receipt(event) | {
            "parent_proxy_session_id_sha256": parent_id,
            "parent_call_id_sha256": binding["parent_call_id_sha256"],
            "offer_id_sha256": hash_identifier(offer_id),
            "label_sha256": receipt_sha256(request["label"]),
        })
    return receipts if len(receipts) == 1 else []


def parse_event_timestamp(value: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def ordered_timestamps(*values: object) -> bool:
    parsed = [parse_event_timestamp(value) if isinstance(value, str) else None for value in values]
    if any(value is None or value.tzinfo is None for value in parsed):
        return False
    return all(left <= right for left, right in zip(parsed, parsed[1:]))


def settled_event_request(event: dict[str, Any]) -> dict[str, Any] | None:
    body, response = event.get("request_body"), event.get("response")
    if not isinstance(body, str) or not isinstance(response, dict) or not isinstance(event.get("event_id"), str):
        return None
    digest = sha256(body.encode()).hexdigest()
    if (
        event.get("request_sha256") != digest
        or response.get("protocol_version") != 1
        or response.get("event_id") != event["event_id"]
        or response.get("request_sha256") != digest
        or not ordered_timestamps(event.get("settled_at"))
    ):
        return None
    try:
        envelope = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(envelope, dict) or set(envelope) != {"event_id", "event"} or envelope["event_id"] != event["event_id"]:
        return None
    request = envelope["event"]
    return request if isinstance(request, dict) and request.get("event") == event.get("event") else None


def project_denial_receipts(bindings: object, events: object, gateway_tool_names: object = None, local_probe: dict[str, Any] | None = None) -> list[dict[str, Any]]:
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
            for receipt in [project_denial_receipt(binding, event, gateway_tool_names, local_probe)]
            if receipt is not None
        ]
        if len(matches) != 1:
            return []
        receipts.extend(matches)
    return receipts


def project_denial_receipt(binding: dict[str, Any], event: dict[str, Any], gateway_tool_names: object, local_probe: dict[str, Any] | None = None) -> dict[str, Any] | None:
    call_id = binding.get("call_id")
    session_id = binding.get("proxy_session_id")
    bound_auth_scope_hash = binding.get("bound_auth_scope_hash")
    target_name = canonical_target_name(binding.get("target_name"), gateway_tool_names, local_probe)
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
    child_actor_id = binding.get("child_actor_id")
    expected_fields = {"event", "root_id", "calls"}
    if child_actor_id is not None:
        if not isinstance(child_actor_id, str) or not child_actor_id:
            return None
        expected_fields.add("child_id")
    if (
        set(proposal) != expected_fields
        or proposal.get("event") != "tool_calls"
        or proposal.get("root_id") != binding.get("root_id")
        or proposal.get("child_id") != child_actor_id
        or not isinstance(calls, list)
        or len(calls) != 1
        or not isinstance(calls[0], dict)
    ):
        return None
    call = calls[0]
    if (
        set(call) != {"call_id", "tool", "arguments", "spawn"}
        or call.get("call_id") != call_id
        or canonical_target_name(call.get("tool"), gateway_tool_names, local_probe) != target_name
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
        "child_actor_id_sha256": hash_identifier(child_actor_id),
        "bound_auth_scope_hash": bound_auth_scope_hash,
        "target_name": target_name,
        "arguments_sha256": receipt_sha256(target_arguments),
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
            binding.get("child_actor_id_sha256"),
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
            receipt.get("child_actor_id_sha256"),
            receipt.get("bound_auth_scope_hash"),
            receipt.get("target_name"),
            receipt.get("arguments_sha256"),
        )
        for receipt in receipts
    }
    return len(expected) == len(bindings) and len(observed) == len(receipts) and expected == observed


def parent_publication_completed(bindings: list[dict[str, Any]], parent_proxy_id: str | None, child_end_at: str | None) -> bool:
    publications = [binding for binding in bindings if binding.get("target_name") == "publish"]
    return (
        is_sha256(parent_proxy_id) and len(publications) == 1
        and publications[0].get("proxy_session_id_sha256") == parent_proxy_id
        and publications[0].get("state") == "result_admitted"
        and ordered_timestamps(child_end_at, publications[0].get("authorization_at"), publications[0].get("result_admitted_at"))
    )


def parent_publication_denied(
    bindings: list[dict[str, Any]],
    receipts: list[dict[str, Any]],
    parent_proxy_id: str | None,
    child_end_at: str | None,
) -> bool:
    if not is_sha256(parent_proxy_id) or child_end_at is None:
        return False
    parent_bindings = [
        binding
        for binding in bindings
        if binding.get("target_name") == "publish"
    ]
    parent_receipts = [
        receipt
        for receipt in receipts
        if receipt.get("target_name") == "publish"
    ]
    return (
        bool(parent_bindings)
        and all(binding.get("proxy_session_id_sha256") == parent_proxy_id and binding.get("state") == "denied" for binding in parent_bindings)
        and len(parent_bindings) == len(parent_receipts)
        and exact_denial_receipts_match(parent_bindings, parent_receipts)
        and all(receipt.get("basis") == "readers_not_public" for receipt in parent_receipts)
        and all(
            ordered_timestamps(child_end_at, binding.get("authorization_at"), receipt.get("settled_at"))
            for binding in parent_bindings
            for receipt in parent_receipts
            if binding.get("call_row_id_sha256") == receipt.get("call_row_id_sha256")
        )
    )


def valid_child_binding(value: dict[str, Any]) -> bool:
    required_hashes = (
        "parent_proxy_session_id_sha256",
        "child_proxy_session_id_sha256",
        "parent_client_session_id_sha256",
        "child_client_session_id_sha256",
        "parent_call_id_sha256",
    )
    return (
        all(is_sha256(value.get(name)) for name in required_hashes)
        and value.get("same_owner_scope") is True
        and value.get("same_profile") is True
        and value.get("same_root") is True
        and value.get("spawn_binding_consumed") is True
    )


def valid_child_attachment(client: str, value: dict[str, Any]) -> bool:
    if not valid_child_binding(value):
        return False
    contract = NATIVE_CHILD_CONTRACTS.get(client)
    if contract is None:
        return False
    return (
        value.get("parent_emitted_name") in contract["emitted_names"]
        and value.get("parent_target_name") == contract["target_name"]
        and (
            not contract["requires_signed_carrier"]
            or value.get("signed_carrier_present") is True
        )
        and value.get("task_alias_count") == contract["task_alias_count"]
        and (client != "codex" or value.get("task_alias_matches_child") is True)
    )


def exact_child_runtime_fact(value: object, child_ids: list[str], fact_key: str) -> bool:
    if not child_ids or not isinstance(value, dict):
        return False
    expected = sorted(child_ids)
    return (
        value.get("expected_child_ids_sha256") == expected
        and value.get(fact_key) == expected
    )


def is_sha256(value: object) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f]{64}", value))


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


def canonical_target_name(value: object, gateway_tool_names: object = None, local_probe: dict[str, Any] | None = None) -> str | None:
    if local_probe is not None and value in {local_probe.get("target_name"), local_probe.get("emitted_name")}:
        return "local_callback"
    return fixture_tool_name(value, gateway_tool_names)


def sql_literal(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


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
