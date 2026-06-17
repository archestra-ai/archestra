"""Seed a fresh Archestra instance with everything a benchmark run needs the agent to have:

  - a real LLM provider key + synced models (so the agent can actually run);
  - the environment's skills, imported from GitHub pinned to a commit/branch/tag;
  - the environment's fixture MCP servers, registered exactly like the benchmark MCP.

Seeding is loud: a key whose connection test fails, a model that never syncs, a skill ref that
resolves to nothing, or an MCP whose tools never appear is a hard error, never a silently degraded
run.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass

from archestra_client import (
    CatalogCreate,
    LlmKeyCreate,
)
from contracts import JsonValue, Provider, Scope
from envs import Mcp
from eval_client import EvalClient

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvedModel:
    """A synced model resolved to the UUIDs a conversation needs."""

    model_id: str
    api_key_id: str


@dataclass(frozen=True)
class RegisteredMcp:
    tools: tuple[dict[str, JsonValue], ...]


def ensure_provider_and_models(
    client: EvalClient,
    *,
    provider: Provider,
    api_key: str,
    models: list[str],
    base_url: str | None = None,  # override the provider's default endpoint (e.g. an Anthropic-compatible gateway)
    key_name: str | None = None,  # name the provider key (unique per lane so same-provider lanes coexist)
    is_primary: bool = True,  # only one primary key per provider is allowed; later same-provider keys pass False
    scope: Scope = "personal",  # provider keys are owned by the (admin) user, like the e2e setup
    timeout_s: float = 180.0,
    interval_s: float = 3.0,
) -> dict[str, ResolvedModel]:
    """Create the provider key and resolve each requested model to its UUID + this key's id.

    Key creation triggers a fire-and-forget sync server-side; we poll, and force a sync once if a
    requested model hasn't appeared yet. Resolution is scoped to the key we just created, so two keys
    of the same provider (distinct gateways) resolve their models to the right key, never each other's."""
    created = client.create_llm_key(
        LlmKeyCreate(
            provider=provider, scope=scope, apiKey=api_key, baseUrl=base_url,
            name=key_name or f"bench-{provider}", isPrimary=is_primary,
        )
    )
    key_id = _require_str(created, "id")
    deadline = time.monotonic() + timeout_s
    forced = False
    while True:
        rows = client.list_models()
        resolved = _resolve(rows, models, key_id)
        missing = [name for name in models if name not in resolved]
        if not missing:
            return resolved
        available = sorted(
            n for r in rows if r.get("provider") == provider and isinstance(n := r.get("modelId"), str)
        )
        if not forced:
            logger.info("forcing model sync; still missing %s; available: %s", missing, available)
            client.sync_models()
            forced = True
        if time.monotonic() >= deadline:
            raise SystemExit(f"models never synced after {timeout_s}s: {missing}; available: {available}")
        time.sleep(interval_s)


def seed_skill_ref(
    client: EvalClient, *, repo: str, path: str | None, ref: str, cap: int | None = None, scope: Scope = "org"
) -> list[str]:
    """Import an environment's skills from a public GitHub repo, pinned to `ref` (commit/branch/tag).

    Discovers the skills under `path` at the pinned ref and imports up to `cap` of them (None = all).
    A ref that resolves to no skills is a hard error -- a misconfigured environment, not a degraded
    run."""
    discovered = client.discover_github_skills(repo, path=path, ref=ref)
    paths = [p for s in discovered if isinstance(p := s.get("skillPath"), str)]
    if not paths:
        where = f"{repo}@{ref}" + (f" under {path!r}" if path else "")
        raise SystemExit(f"no skills discovered in {where}; refusing to run a misconfigured environment")
    selected = paths if cap is None else paths[:cap]
    if cap is not None and len(paths) > cap:
        logger.info("importing %d of %d skills from %s@%s (capped)", cap, len(paths), repo, ref)
    client.import_github_skills(repo, selected, scope=scope, ref=ref)
    logger.info("imported %d skills from %s@%s", len(selected), repo, ref)
    return selected


def register_remote_mcp(
    client: EvalClient, *, name: str, server_url: str, scope: Scope = "org", agent_ids: list[str] | None = None
) -> RegisteredMcp:
    """Register a remote (HTTP) MCP server as a catalog item and install it, optionally assigning its
    tools to `agent_ids` at install time. Remote MCP tools must be assigned via the install (they
    cannot be bulk-assigned afterward), and they are discovered synchronously."""
    catalog = client.create_catalog_item(
        CatalogCreate(name=name, serverType="remote", scope=scope, serverUrl=server_url)
    )
    catalog_id = _require_str(catalog, "id")
    server = client.install_mcp(name=name, catalog_id=catalog_id, scope=scope, agent_ids=agent_ids)
    server_id = _require_str(server, "id")
    tools = tuple(client.list_mcp_server_tools(server_id))
    if not tools:
        raise SystemExit(f"MCP server {name!r} registered but exposed no tools; refusing to run")
    return RegisteredMcp(tools=tools)


def seed_mcp_fixtures(
    client: EvalClient, mcps: tuple[Mcp, ...], *, scope: Scope = "org", agent_ids: list[str] | None = None
) -> list[RegisteredMcp]:
    """Seed an environment's remote MCP servers (extra tools the agent may use), via the same path the
    benchmark MCP uses, assigning their tools to `agent_ids` at install time."""
    registered: list[RegisteredMcp] = []
    for fixture in mcps:
        logger.info("seeding fixture MCP %s", fixture.name)
        registered.append(
            register_remote_mcp(
                client, name=fixture.name, server_url=fixture.server_url, scope=scope, agent_ids=agent_ids
            )
        )
    return registered


# === internal ===


def _resolve(rows: list[dict[str, JsonValue]], wanted: list[str], key_id: str) -> dict[str, ResolvedModel]:
    """Resolve each wanted model to its UUID, but only via rows linked to `key_id` -- so a model that
    several same-provider keys (distinct gateways) expose resolves to this lane's key, not another's."""
    found: dict[str, ResolvedModel] = {}
    for row in rows:
        name = row.get("modelId")
        if not isinstance(name, str) or name not in wanted or not _links_key(row, key_id):
            continue
        found[name] = ResolvedModel(model_id=_require_str(row, "id"), api_key_id=key_id)
    return found


def _links_key(model: Mapping[str, JsonValue], key_id: str) -> bool:
    keys = model.get("apiKeys")
    if not isinstance(keys, list):
        return False
    return any(isinstance(k, dict) and k.get("id") == key_id for k in keys)


def _require_str(obj: Mapping[str, JsonValue], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise SystemExit(f"expected string field {key!r}, got {value!r}")
    return value
