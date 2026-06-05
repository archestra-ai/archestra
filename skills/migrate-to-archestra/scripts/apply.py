# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27", "pydantic>=2"]
# ///
"""apply a model-authored migration plan against an archestra instance.

the model authors DECISIONS (what maps to what, scope, naming, answers); this script
deterministically builds + validates the typed payloads and performs idempotent creates.
no payload is ever model-authored raw -- the weakest link is removed.

connection (non dry-run) comes from env: ARCHESTRA_BASE_URL, ARCHESTRA_API_KEY.

usage:
    uv run apply.py --inventory inventory.json --plan migration_plan.json --dry-run
    uv run apply.py --inventory inventory.json --plan migration_plan.json --out result.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from archestra_client import (
    AgentCreate,
    ArchestraApiError,
    ArchestraClient,
    CatalogCreate,
    LlmKeyCreate,
    LocalConfig,
    McpEnvVar,
    McpInstall,
    PolicyCondition,
    RemoteConfig,
    Scope,
    SkillCreate,
    SkillFile,
    ToolInvocationPolicyCreate,
)

TargetKind = Literal[
    "agent", "skill", "mcp_catalog", "mcp_install", "llm_key", "tool_policy"
]
# deterministic apply order: keys before the agent, skills/catalog next, install, then policies.
_ORDER: dict[str, int] = {
    "llm_key": 0, "agent": 1, "skill": 2, "mcp_catalog": 3, "mcp_install": 4, "tool_policy": 5
}
# env keys whose values must be treated as install-time secrets even if discovery left them intact.
_SECRET_ENV_KEY = re.compile(r"(key|token|secret|password|passwd|api[_-]?key|authorization|credential)", re.I)


def _nonmigrate_outcome(action: str) -> str:
    """an intentional skip is 'skipped'; a deferred item is 'manual'."""
    return "skipped" if action == "skip" else "manual"


def _redacted_for_print(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """strip user-supplied secrets before printing a payload in --dry-run."""
    match kind:
        case "llm_key":
            return {**payload, "apiKey": "<redacted>"}
        case "mcp_install" if payload.get("environmentValues"):
            return {**payload, "environmentValues": {k: "<redacted>" for k in payload["environmentValues"]}}
        case _:
            return payload


class Decision(BaseModel):
    source_id: str
    action: Literal["migrate", "skip", "manual"] = "migrate"
    target_kind: TargetKind
    scope: Scope
    name_override: str | None = None
    notes: str | None = None
    user_answers: dict[str, Any] = {}


class MigrationPlan(BaseModel):
    schema_version: int
    default_scope: Scope
    decisions: list[Decision]


class ResultOp(BaseModel):
    source_id: str
    target_kind: str
    name: str
    outcome: Literal["created", "skipped", "failed", "manual", "planned", "invalid"]
    archestra_id: str | None = None
    error: str | None = None
    detail: str | None = None


# --- payload builders (offline, deterministic) -------------------------------


def _item_index(inventory: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {it["id"]: it for it in inventory.get("items", [])}


def _front_matter(name: str, description: str) -> str:
    # json.dumps yields a double-quoted scalar that is valid YAML, so names/descriptions
    # containing YAML-significant characters cannot break the frontmatter.
    return f"---\nname: {json.dumps(name)}\ndescription: {json.dumps(description)}\n---\n"


def _skill_content_for(item: dict[str, Any], name: str) -> tuple[str, list[SkillFile]]:
    """build (SKILL.md content, bundled files) for a skill-targeted source item."""
    files = [SkillFile(**f) for f in item.get("files", [])]
    kind = item["kind"]
    data = item.get("data", {})

    match kind:
        case "skill":
            # verbatim: the original SKILL.md already carries frontmatter.
            return data["content"], files
        case "subagent":
            desc = (data.get("description") or f"migrated subagent {name}").replace("\n", " ")
            tools = data.get("tools")
            note = ""
            if tools:
                listed = tools if isinstance(tools, str) else ", ".join(tools)
                note = (
                    "\n\n## Original tool allowlist (not enforced)\n"
                    f"This was a Claude Code subagent restricted to: {listed}. "
                    "Archestra skills do not enforce tool allowlists; recorded here for reference.\n"
                )
            return _front_matter(name, desc) + (data.get("body") or "") + note, files
        case "command":
            desc = (data.get("frontmatter", {}).get("description") or f"migrated command {name}").replace("\n", " ")
            return _front_matter(name, desc) + (data.get("body") or ""), files
        case "local_tool":
            entry = data.get("entrypoint", "")
            body = (
                f"# {name}\n\nThis skill wraps the local python tool `{entry}`, bundled below.\n\n"
                f"## Usage\nRun the bundled script:\n```bash\npython3 {entry}\n```\n"
            )
            return _front_matter(name, f"Run the bundled {entry} script.") + body, files
        case _:
            raise ValueError(f"cannot build skill content from kind={kind}")


def _env_var(key: str, value: Any) -> McpEnvVar:
    """a redacted-or-secret-named env var becomes a prompted secret with no inlined value."""
    is_secret = value == "<redacted>" or bool(_SECRET_ENV_KEY.search(key))
    return McpEnvVar(
        key=key, type="secret" if is_secret else "plain_text",
        value=None if is_secret else str(value), promptOnInstallation=is_secret,
    )


def _build_payload(decision: Decision, item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """return (display_name, validated payload dict) for a migrate decision.
    raises ValueError on anything that cannot be built deterministically."""
    name = decision.name_override or item["name"]
    data = item.get("data", {})
    ans = decision.user_answers

    match decision.target_kind:
        case "agent":
            payload = AgentCreate(
                name=name, scope=decision.scope,
                systemPrompt=data.get("body") or None,
                description=(data.get("frontmatter", {}).get("description")
                             or "Migrated from CLAUDE.md"),
            )
            return name, payload.model_dump(exclude_none=True)

        case "skill":
            content, files = _skill_content_for(item, name)
            payload = SkillCreate(content=content, scope=decision.scope, files=files)
            return name, payload.model_dump(exclude_none=True)

        case "mcp_catalog":
            server_type = "remote" if data.get("url") else "local"
            if server_type == "remote":
                cfg = CatalogCreate(
                    name=name, serverType="remote", scope=decision.scope,
                    remoteConfig=RemoteConfig(url=data["url"]),
                )
            else:
                env = [_env_var(k, v) for k, v in (data.get("env") or {}).items()]
                cfg = CatalogCreate(
                    name=name, serverType="local", scope=decision.scope,
                    localConfig=LocalConfig(
                        command=data.get("command") or "",
                        arguments=data.get("args") or [],
                        environment=env,
                    ),
                )
            return name, cfg.model_dump(exclude_none=True)

        case "mcp_install":
            # catalogId is resolved by name at execute time; carry the name + supplied env values.
            env_values = {k: str(v) for k, v in (ans.get("environmentValues") or {}).items()}
            return name, {"catalog_name": name, "scope": decision.scope, "environmentValues": env_values}

        case "llm_key":
            api_key = ans.get("apiKey")
            provider = ans.get("provider")
            if not api_key or not provider:
                raise ValueError("llm_key requires user_answers.apiKey and user_answers.provider")
            payload = LlmKeyCreate(
                provider=provider, scope=decision.scope, apiKey=api_key,
                name=name, isPrimary=ans.get("isPrimary"),
            )
            return name, payload.model_dump(exclude_none=True)

        case "tool_policy":
            # the model must extract the guard's semantics into user_answers.
            required = ("tool_name", "key", "operator", "value")
            missing = [k for k in required if not ans.get(k)]
            if missing:
                raise ValueError(f"tool_policy requires user_answers: {', '.join(missing)}")
            cond = PolicyCondition(key=ans["key"], operator=ans["operator"], value=ans["value"])
            return name, {
                "tool_name": ans["tool_name"],
                "conditions": [cond.model_dump()],
                "action": ans.get("action", "block_always"),
                "reason": ans.get("reason"),
            }

        case _:
            raise ValueError(f"unknown target_kind {decision.target_kind}")


# --- execution (network, idempotent) -----------------------------------------


def _execute(client: ArchestraClient, source_id: str, kind: str, name: str, payload: dict[str, Any]) -> ResultOp:
    def op(**kw: Any) -> ResultOp:
        return ResultOp(source_id=source_id, target_kind=kind, name=name, **kw)

    match kind:
        case "agent":
            if client.list_agents(name=name, scope=payload["scope"]):
                return op(outcome="skipped", detail="agent with this name+scope already exists")
            created = client.create_agent(AgentCreate(**payload))
            return op(outcome="created", archestra_id=created.get("id"))

        case "skill":
            if any(s.get("name") == name for s in client.list_skills(search=name)):
                return op(outcome="skipped", detail="skill with this name already exists")
            created = client.create_skill(SkillCreate(**payload))
            return op(outcome="created", archestra_id=created.get("id"))

        case "mcp_catalog":
            if any(c.get("name") == name for c in client.list_catalog()):
                return op(outcome="skipped", detail="catalog item with this name already exists")
            created = client.create_catalog_item(CatalogCreate(**payload))
            return op(outcome="created", archestra_id=created.get("id"))

        case "mcp_install":
            catalog = next((c for c in client.list_catalog() if c.get("name") == payload["catalog_name"]), None)
            if catalog is None:
                return op(outcome="failed",
                          error=f"no catalog item named {payload['catalog_name']} to install")
            # disambiguate existing installs by (catalogId, scope) -- the finest grain the api exposes.
            if any(s.get("scope") == payload["scope"] for s in client.list_mcp_servers(catalog_id=catalog["id"])):
                return op(outcome="skipped", detail="an install of this catalog item at this scope already exists")
            created = client.install_mcp_server(McpInstall(
                catalogId=catalog["id"], scope=payload["scope"],
                environmentValues=payload.get("environmentValues", {}),
            ))
            return op(outcome="created", archestra_id=created.get("id"))

        case "llm_key":
            if any(k.get("name") == name for k in client.list_llm_keys(search=name, provider=payload["provider"])):
                return op(outcome="skipped", detail="llm key with this name+provider already exists")
            created = client.create_llm_key(LlmKeyCreate(**payload))
            return op(outcome="created", archestra_id=created.get("id"))

        case "tool_policy":
            tool = next((t for t in client.list_tools(search=payload["tool_name"])
                         if t.get("name") == payload["tool_name"]), None)
            if tool is None:
                return op(outcome="manual",
                          detail=(f"no archestra tool named '{payload['tool_name']}' to attach the guard to; "
                                  "apply this policy manually once the target tool exists. proposed: "
                                  + json.dumps({k: payload[k] for k in ("conditions", "action", "reason")})))
            existing = client.list_tool_invocation_policies(tool_id=tool["id"])
            if any(p.get("action") == payload["action"] and p.get("conditions") == payload["conditions"]
                   for p in existing):
                return op(outcome="skipped", detail="an equivalent tool-invocation policy already exists")
            created = client.create_tool_invocation_policy(ToolInvocationPolicyCreate(
                toolId=tool["id"], conditions=[PolicyCondition(**c) for c in payload["conditions"]],
                action=payload["action"], reason=payload.get("reason"),
            ))
            return op(outcome="created", archestra_id=created.get("id"))

        case _:
            return op(outcome="failed", error=f"unknown target_kind {kind}")


def main() -> int:
    ap = argparse.ArgumentParser(description="apply a migration plan to archestra")
    ap.add_argument("--inventory", type=Path, required=True)
    ap.add_argument("--plan", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("migration_result.json"))
    ap.add_argument("--dry-run", action="store_true", help="build+validate payloads, touch no network")
    args = ap.parse_args()

    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    plan = MigrationPlan.model_validate_json(args.plan.read_text(encoding="utf-8"))
    index = _item_index(inventory)

    # build phase: deterministic, offline. ordered for correct dependencies.
    built: list[tuple[Decision, str, dict[str, Any] | None, str]] = []  # (decision, name, payload|None, error)
    for decision in plan.decisions:
        if decision.action != "migrate":
            built.append((decision, decision.source_id, None, decision.action))
            continue
        item = index.get(decision.source_id)
        if item is None:
            built.append((decision, decision.source_id, None, f"no inventory item {decision.source_id}"))
            continue
        try:
            name, payload = _build_payload(decision, item)
            built.append((decision, name, payload, ""))
        except (ValueError, KeyError) as e:
            built.append((decision, decision.source_id, None, str(e)))
    built.sort(key=lambda b: _ORDER.get(b[0].target_kind, 99))

    results: list[ResultOp] = []

    if args.dry_run:
        for decision, name, payload, err in built:
            if decision.action != "migrate":
                results.append(ResultOp(source_id=decision.source_id, target_kind=decision.target_kind,
                                        name=name, outcome=_nonmigrate_outcome(decision.action),
                                        detail=decision.notes))
            elif payload is None:
                results.append(ResultOp(source_id=decision.source_id, target_kind=decision.target_kind,
                                        name=name, outcome="invalid", error=err))
            else:
                shown = _redacted_for_print(decision.target_kind, payload)
                print(f"[dry-run] {decision.target_kind}: {name}\n{json.dumps(shown, indent=2)}")
                results.append(ResultOp(source_id=decision.source_id, target_kind=decision.target_kind,
                                        name=name, outcome="planned"))
        return _finish(results, args.out)

    base_url = os.environ.get("ARCHESTRA_BASE_URL")
    api_key = os.environ.get("ARCHESTRA_API_KEY")
    if not base_url or not api_key:
        print("error: ARCHESTRA_BASE_URL and ARCHESTRA_API_KEY must be set (or use --dry-run)", file=sys.stderr)
        return 2

    created_skill_or_agent = False
    with ArchestraClient(base_url, api_key=api_key) as client:
        for decision, name, payload, err in built:
            if decision.action != "migrate":
                results.append(ResultOp(source_id=decision.source_id, target_kind=decision.target_kind,
                                        name=name, outcome=_nonmigrate_outcome(decision.action),
                                        detail=decision.notes))
                continue
            if payload is None:
                results.append(ResultOp(source_id=decision.source_id, target_kind=decision.target_kind,
                                        name=name, outcome="invalid", error=err))
                continue
            try:
                op = _execute(client, decision.source_id, decision.target_kind, name, payload)
            except ArchestraApiError as e:
                op = ResultOp(source_id=decision.source_id, target_kind=decision.target_kind, name=name,
                              outcome="failed", error=str(e))
            results.append(op)
            if op.target_kind in ("skill", "agent") and op.outcome in ("created", "skipped"):
                created_skill_or_agent = True

        if created_skill_or_agent:
            try:
                client.enable_skill_defaults()
                results.append(ResultOp(source_id="-", target_kind="skill_defaults", name="enable-defaults",
                                        outcome="created", detail="org skill tools enabled + backfilled"))
            except ArchestraApiError as e:
                results.append(ResultOp(source_id="-", target_kind="skill_defaults", name="enable-defaults",
                                        outcome="failed", error=str(e)))

    return _finish(results, args.out)


def _finish(results: list[ResultOp], out: Path) -> int:
    summary: dict[str, int] = {}
    for r in results:
        summary[r.outcome] = summary.get(r.outcome, 0) + 1
    out.write_text(json.dumps(
        {"schema_version": 1, "summary": summary, "ops": [r.model_dump() for r in results]},
        indent=2), encoding="utf-8")
    print(f"wrote {out}: " + ", ".join(f"{k}={v}" for k, v in sorted(summary.items())))
    return 1 if (summary.get("failed", 0) or summary.get("invalid", 0)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
