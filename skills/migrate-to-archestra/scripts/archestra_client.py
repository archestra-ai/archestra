# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27", "pydantic>=2"]
# ///
"""thin, typed REST client for the archestra platform api.

this module is intentionally a *thin* wrapper: it does request/response plumbing and
typed payloads, but holds no idempotency or migration logic (that lives in apply.py).
every non-2xx response raises ArchestraApiError verbatim -- no silent error handling.
"""

from __future__ import annotations

import time
from typing import Any, Literal
from urllib.parse import urljoin

import httpx
from pydantic import BaseModel, ConfigDict

Scope = Literal["personal", "team", "org"]
ServerType = Literal["local", "remote"]
Provider = Literal["anthropic", "openai", "gemini", "azure", "bedrock", "vertex"]
PolicyAction = Literal[
    "allow_when_context_is_untrusted",
    "block_when_context_is_untrusted",
    "block_always",
    "require_approval",
]
ConditionOperator = Literal[
    "equal", "notEqual", "contains", "notContains", "startsWith", "endsWith", "regex"
]


class _Payload(BaseModel):
    """base for request bodies: forbid unknown fields so typos fail locally, not on the wire."""

    model_config = ConfigDict(extra="forbid")


class AgentCreate(_Payload):
    name: str
    scope: Scope
    agentType: Literal["agent"] = "agent"
    systemPrompt: str | None = None
    description: str | None = None
    icon: str | None = None


class SkillFile(_Payload):
    path: str
    content: str
    encoding: Literal["utf8", "base64"] = "utf8"


class SkillCreate(_Payload):
    content: str
    scope: Scope
    files: list[SkillFile] = []
    teamIds: list[str] | None = None


class McpEnvVar(_Payload):
    key: str
    type: Literal["plain_text", "secret", "boolean", "number"] = "plain_text"
    value: str | None = None
    promptOnInstallation: bool = False
    required: bool = False
    description: str | None = None


class LocalConfig(_Payload):
    command: str
    arguments: list[str] = []
    environment: list[McpEnvVar] = []


class RemoteConfig(_Payload):
    url: str


class CatalogCreate(_Payload):
    name: str
    serverType: ServerType
    scope: Scope
    description: str | None = None
    localConfig: LocalConfig | None = None
    remoteConfig: RemoteConfig | None = None


class McpInstall(_Payload):
    catalogId: str
    scope: Scope
    environmentValues: dict[str, str] = {}
    agentIds: list[str] = []


class LlmKeyCreate(_Payload):
    provider: Provider
    scope: Scope
    apiKey: str
    name: str | None = None
    baseUrl: str | None = None
    isPrimary: bool | None = None


class PolicyCondition(_Payload):
    key: str
    operator: ConditionOperator
    value: str


class ToolInvocationPolicyCreate(_Payload):
    toolId: str
    conditions: list[PolicyCondition]
    action: PolicyAction
    reason: str | None = None


class ArchestraApiError(RuntimeError):
    """a non-2xx response. carries the full body so failures are never opaque."""

    def __init__(self, method: str, url: str, status: int, body: str) -> None:
        super().__init__(f"{method} {url} -> {status}: {body}")
        self.method = method
        self.url = url
        self.status = status
        self.body = body


class ArchestraClient:
    """talks to a single archestra instance. auth is either a session cookie
    (after sign_in) or an api key sent as the raw Authorization header (no Bearer)."""

    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        headers = {"Authorization": api_key} if api_key else {}
        self._http = httpx.Client(timeout=timeout, headers=headers, follow_redirects=True)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "ArchestraClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = urljoin(self.base_url, path.lstrip("/"))
        resp = self._http.request(method, url, **kwargs)
        if resp.status_code // 100 != 2:
            raise ArchestraApiError(method, url, resp.status_code, resp.text)
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return resp.text

    # --- connectivity & auth -------------------------------------------------

    def wait_ready(self, timeout_s: float = 180.0, interval_s: float = 3.0) -> dict[str, Any]:
        """poll GET /ready until the database is connected. raises on timeout."""
        deadline = time.monotonic() + timeout_s
        last: str = "no response"
        while time.monotonic() < deadline:
            try:
                resp = self._http.get(urljoin(self.base_url, "ready"))
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("database") == "connected":
                        return data
                    last = f"200 but not connected: {data}"
                else:
                    last = f"{resp.status_code}: {resp.text}"
            except (httpx.HTTPError, ValueError) as e:
                last = str(e)
            time.sleep(interval_s)
        raise TimeoutError(f"archestra not ready after {timeout_s}s; last: {last}")

    def sign_in(self, email: str, password: str) -> None:
        """better-auth email sign-in; persists the session cookie on this client."""
        self._request("POST", "/api/auth/sign-in/email", json={"email": email, "password": password})

    def mint_api_key(self, name: str) -> str:
        """create an api key for the signed-in user and switch this client to use it.
        the key value is only returned once by the server."""
        body = self._request("POST", "/api/api-keys", json={"name": name})
        key = body.get("key")
        if not key:
            raise RuntimeError(f"/api/api-keys returned no key: {body}")
        self._http.headers["Authorization"] = key
        return key

    # --- agents --------------------------------------------------------------

    def list_agents(self, name: str | None = None, scope: Scope | None = None) -> list[dict[str, Any]]:
        params = {k: v for k, v in {"name": name, "scope": scope}.items() if v is not None}
        return _items(self._request("GET", "/api/agents", params=params))

    def create_agent(self, payload: AgentCreate) -> dict[str, Any]:
        return self._request("POST", "/api/agents", json=payload.model_dump(exclude_none=True))

    # --- skills --------------------------------------------------------------

    def list_skills(self, search: str | None = None) -> list[dict[str, Any]]:
        params = {"search": search} if search else {}
        return _items(self._request("GET", "/api/skills", params=params))

    def create_skill(self, payload: SkillCreate) -> dict[str, Any]:
        return self._request("POST", "/api/skills", json=payload.model_dump(exclude_none=True))

    def enable_skill_defaults(self) -> dict[str, Any]:
        """enable org skill tools (list_skills/activate_skill/read_skill_file) and backfill
        them onto existing agents. idempotent."""
        return self._request("POST", "/api/skills/enable-defaults")

    # --- mcp catalog & install ----------------------------------------------

    def list_catalog(self) -> list[dict[str, Any]]:
        return _items(self._request("GET", "/api/internal_mcp_catalog"))

    def create_catalog_item(self, payload: CatalogCreate) -> dict[str, Any]:
        return self._request(
            "POST", "/api/internal_mcp_catalog", json=payload.model_dump(exclude_none=True)
        )

    def list_mcp_servers(self, catalog_id: str | None = None) -> list[dict[str, Any]]:
        params = {"catalogId": catalog_id} if catalog_id else {}
        return _items(self._request("GET", "/api/mcp_server", params=params))

    def install_mcp_server(self, payload: McpInstall) -> dict[str, Any]:
        return self._request("POST", "/api/mcp_server", json=payload.model_dump(exclude_none=True))

    # --- llm provider keys ---------------------------------------------------

    def list_llm_keys(
        self, search: str | None = None, provider: Provider | None = None
    ) -> list[dict[str, Any]]:
        params = {k: v for k, v in {"search": search, "provider": provider}.items() if v is not None}
        return _items(self._request("GET", "/api/llm-provider-api-keys", params=params))

    def create_llm_key(self, payload: LlmKeyCreate) -> dict[str, Any]:
        return self._request(
            "POST", "/api/llm-provider-api-keys", json=payload.model_dump(exclude_none=True)
        )

    # --- tools & policies ----------------------------------------------------

    def list_tools(self, search: str | None = None) -> list[dict[str, Any]]:
        params = {"search": search} if search else {}
        return _items(self._request("GET", "/api/tools", params=params))

    def list_tool_invocation_policies(self, tool_id: str | None = None) -> list[dict[str, Any]]:
        items = _items(self._request("GET", "/api/autonomy-policies/tool-invocation"))
        return [p for p in items if tool_id is None or p.get("toolId") == tool_id]

    def create_tool_invocation_policy(self, payload: ToolInvocationPolicyCreate) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/autonomy-policies/tool-invocation",
            json=payload.model_dump(exclude_none=True),
        )


def _items(body: Any) -> list[dict[str, Any]]:
    """unwrap a list endpoint's response (bare array or {items|data: [...]} envelope).

    raises loudly on an unrecognized shape rather than returning [] -- a silent empty
    list would make idempotency checks miss existing entities and create duplicates.
    existence checks always pass a name/search filter, so results stay within one page;
    pagination beyond the first page is therefore not followed here by design.
    """
    match body:
        case list():
            return body
        case {"items": list() as items}:
            return items
        case {"data": list() as items}:
            return items
        case _:
            raise ValueError(f"unexpected list-response shape: {type(body).__name__}: {str(body)[:200]}")
