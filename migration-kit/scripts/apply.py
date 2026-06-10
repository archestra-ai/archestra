# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""apply a model-authored migration plan against an archestra instance.

the model authors DECISIONS (what maps to what, scope, naming, answers); this script
deterministically builds + validates the typed payloads and performs idempotent creates.
no payload is ever model-authored raw -- the weakest link is removed.

zero third-party dependencies: the inventory is read back through contracts.parse_inventory
into typed dataclasses (so the cross-script boundary is no longer dict[str, Any]) and the api
client is the bundled stdlib-only archestra_client.

connection (non dry-run) comes from env: ARCHESTRA_BASE_URL, ARCHESTRA_API_KEY.

usage:
    python3 apply.py --inventory inventory.json --plan migration_plan.json --dry-run
    python3 apply.py --inventory inventory.json --plan migration_plan.json --out result.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Union

from archestra_client import (
    AgentCreate,
    ArchestraApiError,
    ArchestraClient,
    CatalogCreate,
    HookCreate,
    LlmKeyCreate,
    LocalConfig,
    McpEnvVar,
    McpInstall,
    PolicyCondition,
    SkillCreate,
    SkillFile,
    ToolInvocationPolicyCreate,
    to_payload,
)
from contracts import (
    SECRET_KEY_RE,
    BundledFile,
    ClaudeMdItem,
    CommandItem,
    ContractError,
    Decision,
    FrontMatter,
    HookEvent,
    HookItem,
    Item,
    JsonValue,
    LocalToolItem,
    McpServerItem,
    Outcome,
    PolicyAction,
    ResultOp,
    Scope,
    SkillItem,
    SubagentItem,
    archestra_file_name,
    archestra_hook_event,
    optional_action,
    optional_agent_id,
    optional_file_name,
    parse_inventory,
    parse_plan,
    redact_tokens,
    require_answer,
    require_dict,
    require_hook_content,
    require_list,
    require_operator,
    require_provider,
    require_requirements,
    require_str_field,
    to_jsonable,
    validate_requirements,
)
from frontmatter import emit_frontmatter

# deterministic apply order: keys before the agent, skills/catalog next, install, then policies,
# then hooks (they attach to the already-created primary agent).
_ORDER: dict[str, int] = {
    "llm_key": 0, "agent": 1, "skill": 2, "mcp_catalog": 3, "mcp_install": 4,
    "tool_policy": 5, "hook": 6,
}


def _style(text: str, code: str) -> str:
    if sys.stdout.isatty() and "NO_COLOR" not in os.environ:
        return f"\033[{code}m{text}\033[0m"
    return text


def _outcome_label(outcome: Outcome) -> str:
    match outcome:
        case "planned" | "created":
            return _style(outcome, "32;1")
        case "manual":
            return _style(outcome, "34;1")
        case "skipped":
            return _style(outcome, "36;1")
        case "invalid" | "failed":
            return _style(outcome, "31;1")
    raise ContractError(f"unknown outcome: {outcome}")


# --- built operations: a typed union of what _build_payload produces ----------------------


@dataclass(frozen=True)
class BuiltAgent:
    payload: AgentCreate


@dataclass(frozen=True)
class BuiltSkill:
    payload: SkillCreate


@dataclass(frozen=True)
class BuiltCatalog:
    payload: CatalogCreate


@dataclass(frozen=True)
class BuiltInstall:
    catalog_name: str
    scope: Scope
    environment_values: dict[str, str]
    agent_ids: list[str]
    team_id: str | None = None


@dataclass(frozen=True)
class BuiltLlmKey:
    payload: LlmKeyCreate


@dataclass(frozen=True)
class BuiltPolicy:
    tool_name: str
    conditions: list[PolicyCondition]
    action: PolicyAction
    reason: str | None


@dataclass(frozen=True)
class BuiltHook:
    event: HookEvent
    file_name: str
    content: str
    requirements: list[str]
    enabled: bool
    # explicit agent override; when None, _run_apply fills the primary migrated agent.
    agent_id: str | None = None


Built = Union[
    BuiltAgent, BuiltSkill, BuiltCatalog, BuiltInstall, BuiltLlmKey, BuiltPolicy, BuiltHook
]


def _nonmigrate_outcome(action: str) -> Outcome:
    """an intentional skip is 'skipped'; a deferred item is 'manual'."""
    return "skipped" if action == "skip" else "manual"


def _fm_str(fm: FrontMatter, key: str) -> str | None:
    value = fm.get(key)
    return value if isinstance(value, str) else None


# --- payload builders (offline, deterministic) -------------------------------------------


def _skill_files(item: Item) -> list[SkillFile]:
    return [SkillFile(path=f.path, content=f.content, encoding=f.encoding) for f in item.files]


def _skill_content_for(item: Item, name: str) -> tuple[str, list[SkillFile]]:
    """build (SKILL.md content, bundled files) for a skill-targeted source item."""
    files = _skill_files(item)
    match item:
        case SkillItem():
            # verbatim: the original SKILL.md already carries frontmatter.
            return item.data.content, files
        case SubagentItem():
            desc = (item.data.description or f"migrated subagent {name}").replace("\n", " ")
            note = ""
            tools = item.data.tools
            if tools:
                listed = tools if isinstance(tools, str) else ", ".join(tools)
                note = (
                    "\n\n## Original tool allowlist (not enforced)\n"
                    f"This was a Claude Code subagent restricted to: {listed}. "
                    "Archestra skills do not enforce tool allowlists; recorded here for reference.\n"
                )
            return emit_frontmatter(name, desc) + item.data.body + note, files
        case CommandItem():
            desc = (_fm_str(item.data.frontmatter, "description") or f"migrated command {name}").replace("\n", " ")
            return emit_frontmatter(name, desc) + item.data.body, files
        case LocalToolItem():
            entry = item.data.entrypoint
            body = (
                f"# {name}\n\nThis skill wraps the local python tool `{entry}`, bundled below.\n\n"
                "## Usage\nAfter activating this skill, run the bundled script in the skill sandbox:\n"
                f"```bash\npython3 {entry}\n```\n"
                f"Use `run_command` with `cwd` set to `/skills/{name}` when sandbox tools are available.\n"
            )
            return emit_frontmatter(name, f"Run the bundled {entry} script.") + body, files
        case _:
            raise ContractError(f"cannot build skill content from item kind {item.kind}")


def _agent_source(item: Item) -> tuple[str | None, str | None]:
    """extract (system prompt body, description) from an agent-capable source item."""
    match item:
        case ClaudeMdItem():
            return item.data.body or None, _fm_str(item.data.frontmatter, "description")
        case SubagentItem():
            return item.data.body or None, item.data.description
        case _:
            raise ContractError(f"cannot build an agent from item kind {item.kind}")


def _env_var(key: str, value: str) -> McpEnvVar:
    """a redacted-or-secret-named env var becomes a prompted secret with no inlined value."""
    is_secret = value == "<redacted>" or bool(SECRET_KEY_RE.search(key))
    return McpEnvVar(
        key=key, type="secret" if is_secret else "plain_text",
        value=None if is_secret else value, promptOnInstallation=is_secret,
    )


def _str_answers(value: object, *, ctx: str) -> list[str]:
    out: list[str] = []
    for i, item in enumerate(require_list(value, ctx=ctx)):
        if not isinstance(item, str) or not item:
            raise ContractError(f"{ctx}[{i}]: expected a non-empty string")
        if item not in out:
            out.append(item)
    return out


# when a plan carries both answers, precedence diverges by kind: _team_ids (multi-team
# payloads: agent/skill/catalog) prefers teamIds; _team_id (single-team payloads:
# install/llm_key) prefers teamId. each falls back to the other answer.
def _team_ids(decision: Decision, *, ctx: str) -> list[str] | None:
    if decision.scope != "team":
        return None
    raw = decision.user_answers.get("teamIds")
    if raw is None:
        team_id = decision.user_answers.get("teamId")
        if isinstance(team_id, str) and team_id:
            return [team_id]
        raise ContractError(
            f"{decision.source_id}: team-scoped {decision.target_kind} requires user_answers.teamIds; "
            "choose personal/org scope if no concrete Archestra team should own it"
        )
    team_ids = _str_answers(raw, ctx=f"{ctx}.teamIds")
    if not team_ids:
        raise ContractError(f"{ctx}.teamIds: team-scoped {decision.target_kind} requires at least one team id")
    return team_ids


def _team_id(decision: Decision, *, ctx: str) -> str | None:
    if decision.scope != "team":
        return None
    raw = decision.user_answers.get("teamId")
    if isinstance(raw, str) and raw:
        return raw
    team_ids = _team_ids(decision, ctx=ctx)
    if team_ids is None:
        return None
    if len(team_ids) != 1:
        raise ContractError(f"{ctx}.teamIds: {decision.target_kind} supports exactly one team id")
    return team_ids[0]


def _build_install_env(answers: dict[str, JsonValue], *, ctx: str) -> dict[str, str]:
    raw = answers.get("environmentValues")
    if raw is None:
        return {}
    # json-encode non-string values (not str()) so lists/bools serialize predictably.
    return {k: v if isinstance(v, str) else json.dumps(v)
            for k, v in require_dict(raw, ctx=f"{ctx}.environmentValues").items()}


def _build_agent_ids(answers: dict[str, JsonValue], *, ctx: str) -> list[str]:
    raw = answers.get("agentIds")
    if raw is None:
        return []
    return _str_answers(raw, ctx=f"{ctx}.agentIds")


def _build_payload(decision: Decision, item: Item) -> tuple[str, Built]:
    """return (display_name, typed built op) for a migrate decision.
    raises ContractError on anything that cannot be built deterministically."""
    name = decision.name_override or item.name
    answers = decision.user_answers
    ctx = f"{decision.source_id}.user_answers"

    match decision.target_kind:
        case "agent":
            body, description = _agent_source(item)
            return name, BuiltAgent(AgentCreate(
                name=name, scope=decision.scope, systemPrompt=body,
                description=description or "Migrated from CLAUDE.md",
                teams=_team_ids(decision, ctx=ctx) or [],
            ))

        case "skill":
            content, files = _skill_content_for(item, name)
            return name, BuiltSkill(SkillCreate(
                content=content,
                scope=decision.scope,
                files=files,
                teamIds=_team_ids(decision, ctx=ctx),
            ))

        case "mcp_catalog":
            if not isinstance(item, McpServerItem):
                raise ContractError(f"mcp_catalog requires an mcp_server item, got {item.kind}")
            data = item.data
            if data.transport == "remote":
                if not data.url:
                    raise ContractError(f"{decision.source_id}: remote mcp server has no url")
                cfg = CatalogCreate(name=name, serverType="remote", scope=decision.scope,
                                    serverUrl=data.url, teams=_team_ids(decision, ctx=ctx) or [])
            else:
                env = [_env_var(k, v) for k, v in data.env.items()]
                cfg = CatalogCreate(name=name, serverType="local", scope=decision.scope,
                                    localConfig=LocalConfig(command=data.command or "",
                                                            arguments=data.args, environment=env),
                                    teams=_team_ids(decision, ctx=ctx) or [])
            return name, BuiltCatalog(cfg)

        case "mcp_install":
            # catalogId is resolved by name at execute time; carry the supplied env values.
            return name, BuiltInstall(
                catalog_name=name, scope=decision.scope,
                environment_values=_build_install_env(answers, ctx=ctx),
                agent_ids=_build_agent_ids(answers, ctx=ctx),
                team_id=_team_id(decision, ctx=ctx),
            )

        case "llm_key":
            provider = require_provider(answers, ctx=ctx)
            api_key = require_answer(answers, "apiKey", ctx=ctx)
            is_primary = answers.get("isPrimary")
            base_url = answers.get("baseUrl")
            return name, BuiltLlmKey(LlmKeyCreate(
                provider=provider, scope=decision.scope, apiKey=api_key, name=name,
                isPrimary=is_primary if isinstance(is_primary, bool) else None,
                baseUrl=base_url if isinstance(base_url, str) and base_url else None,
                teamId=_team_id(decision, ctx=ctx),
            ))

        case "tool_policy":
            # the model must extract the guard's semantics into user_answers.
            condition = PolicyCondition(
                key=require_answer(answers, "key", ctx=ctx),
                operator=require_operator(answers, ctx=ctx),
                value=require_answer(answers, "value", ctx=ctx),
            )
            reason = answers.get("reason")
            return name, BuiltPolicy(
                tool_name=require_answer(answers, "tool_name", ctx=ctx),
                conditions=[condition],
                action=optional_action(answers, ctx=ctx),
                reason=reason if isinstance(reason, str) else None,
            )

        case "hook":
            if not isinstance(item, HookItem):
                raise ContractError(f"hook target requires a hook item, got {item.kind}")
            return name, _build_hook(decision, item)


def _hook_bundled_file(item: HookItem, *, ctx: str) -> BundledFile:
    if not item.files:
        raise ContractError(f"{ctx}: bundled hook has no script file")
    return item.files[0]


def _hook_content(decision: Decision, item: HookItem) -> tuple[str, str]:
    """resolve (script content, default file name) for a hook by how its body was discovered."""
    data = item.data
    ctx = f"{decision.source_id}.content"
    match data.source:
        case "bundled":
            bundled = _hook_bundled_file(item, ctx=ctx)
            if bundled.encoding != "utf8":
                raise ContractError(
                    f"{decision.source_id}: bundled hook script is not utf-8 text; cannot run as a hook"
                )
            content = require_hook_content(bundled.content, ctx=ctx)
            return content, (data.file_name or bundled.path.rsplit("/", 1)[-1])
        case "inline":
            if "<redacted>" in data.command:
                raise ContractError(
                    f"{decision.source_id}: inline hook command contains a redacted secret; "
                    "supply the script by hand and map this to manual"
                )
            content = require_hook_content(f"#!/bin/sh\n{data.command}\n", ctx=ctx)
            return content, _synth_file_name(data.event)
        case "unresolved":
            raise ContractError(
                f"{decision.source_id}: hook script could not be resolved from its command; map it to manual"
            )


def _synth_file_name(event: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]", "_", event).strip("_") or "hook"
    return f"{base}.sh"


def _build_hook(decision: Decision, item: HookItem) -> BuiltHook:
    answers = decision.user_answers
    ctx = f"{decision.source_id}.user_answers"
    data = item.data
    event = archestra_hook_event(data.event)
    if event is None:
        raise ContractError(
            f"{decision.source_id}: hook event {data.event!r} has no archestra equivalent; map it to manual"
        )
    content, default_name = _hook_content(decision, item)
    file_name = archestra_file_name(
        optional_file_name(answers, ctx=ctx) or data.file_name or default_name,
        ctx=f"{decision.source_id}.fileName",
    )
    requirements = require_requirements(answers, ctx=ctx)
    if requirements is None:
        requirements = validate_requirements(data.requirements, ctx=f"{decision.source_id}.requirements")
    if file_name.endswith(".sh") and requirements:
        raise ContractError(
            f"{decision.source_id}: a .sh hook takes no requirements "
            "(bash hooks have no dependency mechanism); drop them or use a .py hook"
        )
    return BuiltHook(
        event=event, file_name=file_name, content=content, requirements=requirements,
        enabled=True, agent_id=optional_agent_id(answers, ctx=ctx),
    )


# url credentials that aren't token-shaped: basic-auth userinfo and secret-named query params.
_URL_USERINFO_RE = re.compile(r"(//)[^/@\s]+@")
_URL_SECRET_QUERY_RE = re.compile(
    r"([?&][^=&\s#]*(?:key|token|secret|password|auth|credential)[^=&\s#]*=)[^&\s#]*", re.I)


def _scrub_url(url: str) -> str:
    """mask credentials in a remote server URL before printing it (user:pass@ and secret query
    params, plus any token-shaped value)."""
    url = _URL_USERINFO_RE.sub(r"\1<redacted>@", url)
    url = _URL_SECRET_QUERY_RE.sub(r"\1<redacted>", url)
    return redact_tokens(url)


def _redacted_for_print(built: Built) -> dict[str, JsonValue]:
    """strip user-supplied secrets before printing a built op in --dry-run."""
    match built:
        case BuiltLlmKey(payload):
            shown = to_payload(payload)
            shown["apiKey"] = "<redacted>"
            return shown
        case BuiltInstall():
            return {"catalog_name": built.catalog_name, "scope": built.scope,
                    "teamId": built.team_id, "agentIds": built.agent_ids,
                    "environmentValues": {k: "<redacted>" for k in built.environment_values}}
        case BuiltAgent(payload) | BuiltSkill(payload):
            return to_payload(payload)
        case BuiltCatalog(payload):
            if payload.serverUrl is not None:
                payload = replace(payload, serverUrl=_scrub_url(payload.serverUrl))
            local = payload.localConfig
            if local is not None:
                # redact env values, and scrub credentials embedded in the launch command/args
                # (e.g. --token=sk-...) -- all on the typed dataclass, before serializing.
                payload = replace(payload, localConfig=replace(
                    local,
                    command=redact_tokens(local.command),
                    arguments=[redact_tokens(a) for a in local.arguments],
                    # keep value-less vars value-less (don't fabricate a redacted value).
                    environment=[replace(e, value="<redacted>" if e.value is not None else None)
                                 for e in local.environment],
                ))
            return to_payload(payload)
        case BuiltPolicy():
            return {"tool_name": built.tool_name,
                    "conditions": [to_jsonable(c) for c in built.conditions],
                    "action": built.action, "reason": built.reason}
        case BuiltHook():
            # never echo the script body in dry-run output: a bundled hook is migrated verbatim and
            # may carry credentials that token-shape scrubbing won't catch. show only its size.
            return {"event": built.event, "fileName": built.file_name,
                    "requirements": list(built.requirements), "enabled": built.enabled,
                    "agentId": built.agent_id, "content_chars": len(built.content)}


def _preview_detail(built: Built) -> str:
    match built:
        case BuiltAgent(payload):
            return f"scope={payload.scope}; inherits org default model"
        case BuiltSkill(payload):
            if payload.scope == "team":
                return f"scope=team; team_ids={len(payload.teamIds or [])}; bundled_files={len(payload.files)}"
            return f"scope={payload.scope}; bundled_files={len(payload.files)}"
        case BuiltCatalog(payload):
            match payload.serverType:
                case "remote":
                    return f"scope={payload.scope}; remote MCP catalog item"
                case "local":
                    # don't echo the launch command here -- a flag can carry a plaintext secret
                    # that token-shape scrubbing won't catch; the verbose --dry-run shows the
                    # full (scrubbed) payload for anyone who needs the exact command.
                    return f"scope={payload.scope}; local MCP catalog item"
        case BuiltInstall():
            team = f"; team_id={built.team_id}" if built.team_id else ""
            return (
                f"scope={built.scope}; catalog={built.catalog_name}; "
                f"agent_ids={len(built.agent_ids)}{team}; supplied_env_values={len(built.environment_values)}"
            )
        case BuiltLlmKey(payload):
            return f"scope={payload.scope}; provider={payload.provider}; api_key=<redacted>"
        case BuiltPolicy():
            return f"tool={built.tool_name}; action={built.action}; conditions={len(built.conditions)}"
        case BuiltHook():
            agent = built.agent_id or "primary"
            return (f"event={built.event}; file={built.file_name}; "
                    f"requirements={len(built.requirements)}; agent={agent}")
    raise ContractError("unreachable built operation")


# --- execution (network, idempotent) -----------------------------------------------------


def _execute(client: ArchestraClient, decision: Decision, name: str, built: Built) -> ResultOp:
    def op(outcome: Outcome, *, archestra_id: str | None = None, error: str | None = None,
           detail: str | None = None) -> ResultOp:
        return ResultOp(source_id=decision.source_id, target_kind=decision.target_kind, name=name,
                        outcome=outcome, archestra_id=archestra_id, error=error, detail=detail)

    match built:
        case BuiltAgent(payload):
            existing = client.list_agents(name=name, scope=payload.scope)
            if existing:
                return op("skipped", archestra_id=require_str_field(existing[0], "id", ctx="agent"),
                          detail="agent with this name+scope already exists")
            created = client.create_agent(payload)
            return op("created", archestra_id=require_str_field(created, "id", ctx="agent create response"))

        case BuiltSkill(payload):
            existing = [
                s for s in client.list_skills(search=name)
                if s.get("name") == name and s.get("scope") == payload.scope
            ]
            if existing:
                return op("skipped", archestra_id=require_str_field(existing[0], "id", ctx="skill"),
                          detail="skill with this name+scope already exists")
            created = client.create_skill(payload)
            return op("created", archestra_id=require_str_field(created, "id", ctx="skill create response"))

        case BuiltCatalog(payload):
            existing = [c for c in client.list_catalog() if c.get("name") == name and c.get("scope") == payload.scope]
            if existing:
                return op("skipped", archestra_id=require_str_field(existing[0], "id", ctx="catalog item"),
                          detail="catalog item with this name+scope already exists")
            created = client.create_catalog_item(payload)
            return op("created", archestra_id=require_str_field(created, "id", ctx="catalog create response"))

        case BuiltInstall():
            catalog = next((c for c in client.list_catalog() if c.get("name") == built.catalog_name), None)
            if catalog is None:
                return op("failed", error=f"no catalog item named {built.catalog_name} to install")
            catalog_id = require_str_field(catalog, "id", ctx="catalog item")
            existing = _matching_installs(client.list_mcp_servers(catalog_id=catalog_id), built)
            if existing:
                return op("skipped", archestra_id=require_str_field(existing[0], "id", ctx="mcp server"),
                          detail="an install of this catalog item at this scope already exists")
            created = client.install_mcp_server(McpInstall(
                catalogId=catalog_id, scope=built.scope, environmentValues=built.environment_values,
                agentIds=built.agent_ids, teamId=built.team_id,
            ))
            return op("created", archestra_id=require_str_field(created, "id", ctx="install response"))

        case BuiltLlmKey(payload):
            existing = [
                k for k in client.list_llm_keys(search=name, provider=payload.provider)
                if k.get("name") == name and k.get("scope") == payload.scope and k.get("teamId") == payload.teamId
            ]
            if existing:
                return op("skipped", archestra_id=require_str_field(existing[0], "id", ctx="llm key"),
                          detail="llm key with this name+provider+scope already exists")
            created = client.create_llm_key(payload)
            return op("created", archestra_id=require_str_field(created, "id", ctx="llm key create response"))

        case BuiltPolicy():
            tool = next((t for t in client.list_tools(search=built.tool_name)
                         if t.get("name") == built.tool_name), None)
            if tool is None:
                proposed = json.dumps({"conditions": [to_jsonable(c) for c in built.conditions],
                                       "action": built.action, "reason": built.reason})
                return op("manual",
                          detail=(f"no archestra tool named '{built.tool_name}' to attach the guard to; "
                                  f"apply this policy manually once the target tool exists. proposed: {proposed}"))
            tool_id = require_str_field(tool, "id", ctx="tool")
            cond_dicts = [to_jsonable(c) for c in built.conditions]
            existing = client.list_tool_invocation_policies(tool_id=tool_id)
            if any(p.get("action") == built.action and p.get("conditions") == cond_dicts for p in existing):
                return op("skipped", detail="an equivalent tool-invocation policy already exists")
            created = client.create_tool_invocation_policy(ToolInvocationPolicyCreate(
                toolId=tool_id, conditions=built.conditions, action=built.action, reason=built.reason,
            ))
            return op("created", archestra_id=require_str_field(created, "id", ctx="policy create response"))

        case BuiltHook():
            if built.agent_id is None:
                return op("failed",
                          error="hook has no agent to attach to; migrate an agent or set user_answers.agentId")
            existing = client.list_hooks(built.agent_id)
            if any(h.get("event") == built.event and h.get("fileName") == built.file_name for h in existing):
                return op("skipped", detail="a hook with this agent+event+fileName already exists")
            created = client.create_hook(HookCreate(
                agentId=built.agent_id, event=built.event, fileName=built.file_name,
                content=built.content, requirements=built.requirements, enabled=built.enabled,
            ))
            return op("created", archestra_id=require_str_field(created, "id", ctx="hook create response"))


def _matching_installs(servers: list[dict[str, JsonValue]], built: BuiltInstall) -> list[dict[str, JsonValue]]:
    match built.scope:
        case "personal":
            return [s for s in servers if s.get("scope") == "personal"]
        case "team":
            return [s for s in servers if s.get("scope") == "team" and s.get("teamId") == built.team_id]
        case "org":
            return [s for s in servers if s.get("scope") == "org"]


@dataclass(frozen=True)
class _Built:
    decision: Decision
    name: str
    built: Built | None
    error: str


def _flag_hook_collisions(built: list[_Built]) -> list[_Built]:
    """archestra enforces a unique (agentId, event, fileName); two hooks that resolve to the same
    triple would make the second silently 'skip exists'. flag the later one invalid so the model
    fixes it with a distinct user_answers.fileName rather than losing a hook.

    this runs before the primary-agent fallback fills agent_id, so it catches the common case (both
    hooks default to the primary agent -> agent_id None on both). the rare case where one pins an
    explicit agentId equal to the eventual primary is caught at execute time by the idempotency
    check, which records a visible 'skipped' rather than a duplicate."""
    seen: set[tuple[str | None, str, str]] = set()
    out: list[_Built] = []
    for b in built:
        op = b.built
        if isinstance(op, BuiltHook):
            key = (op.agent_id, op.event, op.file_name)
            if key in seen:
                out.append(replace(b, built=None, error=(
                    f"duplicate hook (event={op.event}, fileName={op.file_name}); "
                    "set a distinct user_answers.fileName")))
                continue
            seen.add(key)
        out.append(b)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="apply a migration plan to archestra")
    ap.add_argument("--inventory", type=Path, required=True)
    ap.add_argument("--plan", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("migration_result.json"))
    ap.add_argument("--dry-run", action="store_true", help="build+validate payloads, touch no network")
    ap.add_argument("--verbose", action="store_true", help="with --dry-run, also print redacted raw payloads")
    args = ap.parse_args()

    inventory = parse_inventory(json.loads(args.inventory.read_text(encoding="utf-8")))
    plan = parse_plan(json.loads(args.plan.read_text(encoding="utf-8")))
    index: dict[str, Item] = {it.id: it for it in inventory.items}

    # build phase: deterministic, offline. ordered for correct dependencies.
    built: list[_Built] = []
    for decision in plan.decisions:
        if decision.action != "migrate":
            built.append(_Built(decision, decision.source_id, None, decision.action))
            continue
        item = index.get(decision.source_id)
        if item is None:
            built.append(_Built(decision, decision.source_id, None, f"no inventory item {decision.source_id}"))
            continue
        try:
            name, op = _build_payload(decision, item)
            built.append(_Built(decision, name, op, ""))
        except ContractError as exc:
            built.append(_Built(decision, decision.source_id, None, str(exc)))
    built = _flag_hook_collisions(built)
    built.sort(key=lambda b: _ORDER.get(b.decision.target_kind, 99))

    if args.dry_run:
        return _finish(_run_validation(built, verbose=args.verbose, label="dry-run"), args.out)

    if any(_invalid_build(b) for b in built):
        print("error: migration plan has invalid operations; no network changes were made", file=sys.stderr)
        return _finish(_run_validation(built, verbose=args.verbose, label="preflight"), args.out)

    base_url = os.environ.get("ARCHESTRA_BASE_URL")
    api_key = os.environ.get("ARCHESTRA_API_KEY")
    if not base_url or not api_key:
        print("error: ARCHESTRA_BASE_URL and ARCHESTRA_API_KEY must be set (or use --dry-run)", file=sys.stderr)
        return 2

    return _finish(_run_apply(built, base_url, api_key), args.out)


def _run_validation(built: list[_Built], *, verbose: bool, label: str) -> list[ResultOp]:
    results: list[ResultOp] = []
    for b in built:
        if b.built is None:
            result = _nonmigrate_or_invalid(b)
            detail = result.detail or result.error or ""
            suffix = f" -- {detail}" if detail else ""
            print(f"[{label}] {_outcome_label(result.outcome)}: {b.decision.target_kind}: {b.name}{suffix}")
            results.append(result)
            continue
        detail = _preview_detail(b.built)
        print(f"[{label}] {_outcome_label('planned')}: {b.decision.target_kind}: {b.name} -- {detail}")
        if verbose:
            shown = _redacted_for_print(b.built)
            print(json.dumps(shown, indent=2))
        results.append(ResultOp(source_id=b.decision.source_id, target_kind=b.decision.target_kind,
                                name=b.name, outcome="planned"))
    return results


def _invalid_build(b: _Built) -> bool:
    return b.decision.action == "migrate" and b.built is None


def _run_apply(built: list[_Built], base_url: str, api_key: str) -> list[ResultOp]:
    results: list[ResultOp] = []
    created_skill_or_agent = False
    hook_landed = False
    agent_ids: list[str] = []
    primary_agent_id: str | None = None
    with ArchestraClient(base_url, api_key=api_key) as client:
        for b in built:
            if b.built is None:
                results.append(_nonmigrate_or_invalid(b))
                continue
            built_op = b.built
            if isinstance(built_op, BuiltInstall) and not built_op.agent_ids and primary_agent_id:
                built_op = BuiltInstall(
                    catalog_name=built_op.catalog_name,
                    scope=built_op.scope,
                    environment_values=built_op.environment_values,
                    agent_ids=[primary_agent_id],
                    team_id=built_op.team_id,
                )
            if isinstance(built_op, BuiltHook) and built_op.agent_id is None and primary_agent_id:
                built_op = replace(built_op, agent_id=primary_agent_id)
            try:
                op = _execute(client, b.decision, b.name, built_op)
            except (ArchestraApiError, ContractError) as exc:
                op = ResultOp(source_id=b.decision.source_id, target_kind=b.decision.target_kind,
                              name=b.name, outcome="failed", error=str(exc))
            results.append(op)
            if op.target_kind == "agent" and op.outcome in ("created", "skipped") and op.archestra_id:
                if op.archestra_id not in agent_ids:
                    agent_ids.append(op.archestra_id)
                if primary_agent_id is None or op.source_id == "claude_md":
                    primary_agent_id = op.archestra_id
            if op.target_kind in ("skill", "agent") and op.outcome in ("created", "skipped"):
                created_skill_or_agent = True
            if op.target_kind == "hook" and op.outcome in ("created", "skipped"):
                hook_landed = True

        if hook_landed:
            results.append(_hook_feature_check(client))
        if created_skill_or_agent:
            try:
                client.enable_skill_defaults()
                results.append(ResultOp(source_id="-", target_kind="skill_defaults", name="enable-defaults",
                                        outcome="created", detail="org skill tools enabled + backfilled"))
            except ArchestraApiError as exc:
                results.append(ResultOp(source_id="-", target_kind="skill_defaults", name="enable-defaults",
                                        outcome="failed", error=str(exc)))
        if agent_ids:
            results.append(_enable_sandbox_tools(client, agent_ids))
    return results


def _enable_sandbox_tools(client: ArchestraClient, agent_ids: list[str]) -> ResultOp:
    short_names = ("run_command", "upload_file", "download_file")
    try:
        tools = client.list_tools()
    except (ArchestraApiError, ValueError) as exc:
        return _sandbox_warning(f"could not list sandbox tools: {exc}")

    resolved: dict[str, str] = {}
    for short_name in short_names:
        match_ = next(
            (t for t in tools if t.get("name") == short_name or str(t.get("name", "")).endswith(f"__{short_name}")),
            None,
        )
        if match_ is not None:
            try:
                resolved[short_name] = require_str_field(match_, "id", ctx=f"sandbox tool {short_name}")
            except ContractError as exc:
                return _sandbox_warning(str(exc))

    missing = [name for name in short_names if name not in resolved]
    if missing:
        return _sandbox_warning("sandbox tools not available to assign: " + ", ".join(missing))

    assignments: list[dict[str, JsonValue]] = [
        {"agentId": agent_id, "toolId": tool_id}
        for agent_id in agent_ids
        for tool_id in resolved.values()
    ]
    try:
        result = client.bulk_assign_tools(assignments)
    except (ArchestraApiError, ValueError) as exc:
        return _sandbox_warning(f"could not assign sandbox tools: {exc}")

    failed = result.get("failed")
    if isinstance(failed, list) and failed:
        return _sandbox_warning(f"sandbox tool assignment had failures: {json.dumps(failed)}")
    return ResultOp(
        source_id="-",
        target_kind="sandbox_tools",
        name="enable-sandbox-tools",
        outcome="created",
        detail=f"assigned sandbox tools to {len(agent_ids)} migrated agent(s)",
    )


def _hook_feature_check(client: ArchestraClient) -> ResultOp:
    """warn when migrated hooks landed but the agent-hooks feature is off: POST /api/hooks persists
    them, yet they never fire and stay hidden in the UI until an admin enables the feature."""
    try:
        enabled = client.agent_hooks_enabled()
    except (ArchestraApiError, ContractError, ValueError) as exc:
        return _hook_warning(f"could not verify the agent-hooks feature is enabled: {exc}")
    if enabled:
        return ResultOp(source_id="-", target_kind="hook", name="agent-hooks-feature",
                        outcome="created", detail="agent-hooks feature is enabled; migrated hooks will fire")
    return _hook_warning(
        "agent-hooks feature is OFF on this instance -- migrated hooks are saved but will not fire "
        "and stay hidden in the agent UI until an admin sets ARCHESTRA_AGENT_HOOKS_ENABLED=true and the "
        "sandbox runtime is on")


def _hook_warning(detail: str) -> ResultOp:
    return ResultOp(source_id="-", target_kind="hook", name="agent-hooks-feature",
                    outcome="manual", detail=f"warning: {detail}")


def _sandbox_warning(detail: str) -> ResultOp:
    return ResultOp(
        source_id="-",
        target_kind="sandbox_tools",
        name="enable-sandbox-tools",
        outcome="manual",
        detail=f"warning: {detail}",
    )


def _nonmigrate_or_invalid(b: _Built) -> ResultOp:
    if b.decision.action != "migrate":
        return ResultOp(source_id=b.decision.source_id, target_kind=b.decision.target_kind, name=b.name,
                        outcome=_nonmigrate_outcome(b.decision.action), detail=b.decision.notes)
    return ResultOp(source_id=b.decision.source_id, target_kind=b.decision.target_kind, name=b.name,
                    outcome="invalid", error=b.error)


def _finish(results: list[ResultOp], out: Path) -> int:
    summary: dict[str, int] = {}
    for r in results:
        summary[r.outcome] = summary.get(r.outcome, 0) + 1
    out.write_text(json.dumps(
        {"schema_version": 1, "summary": summary, "ops": [to_jsonable(r) for r in results]},
        indent=2), encoding="utf-8")
    print(f"wrote {out}: " + ", ".join(f"{k}={v}" for k, v in sorted(summary.items())))
    return 1 if (summary.get("failed", 0) or summary.get("invalid", 0)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
