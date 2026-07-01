# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""thin, typed, zero-dependency REST client for the archestra platform api.

this module does request/response plumbing and typed payloads only -- no idempotency or
migration logic (that lives in apply.py). every non-2xx response raises ArchestraApiError
verbatim, and a 3xx redirect is treated as an error rather than silently followed (the base
URL is fixed and user-supplied, so a redirect is unexpected and could change a POST's method).
transport and decode failures (connection reset, unknown charset, non-JSON body) are also
converted to ArchestraApiError (status 0) so a single failing call records a real `failed`
outcome in apply.py instead of crashing the whole migration loop; an unexpected list-response
shape raises ContractError, which apply.py handles the same way.

HTTP is the standard library's urllib. a private opener owns a cookie jar so the session
cookie set by sign_in carries to mint_api_key (httpx.Client did this implicitly).
"""

from __future__ import annotations

import http.client
import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Literal

from contracts import (
    ConditionOperator,
    ContractError,
    HookEvent,
    JsonValue,
    PolicyAction,
    Provider,
    Scope,
    ServerType,
    require_dict,
    require_str_field,
    to_jsonable,
)

# --- request payloads (frozen dataclasses; mypy/ty replaces pydantic's extra="forbid") ----


@dataclass(frozen=True)
class AgentCreate:
    name: str
    scope: Scope
    agentType: Literal["agent"] = "agent"
    systemPrompt: str | None = None
    description: str | None = None
    icon: str | None = None
    teams: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SkillFile:
    path: str
    content: str
    encoding: Literal["utf8", "base64"] = "utf8"


@dataclass(frozen=True)
class SkillCreate:
    content: str
    scope: Scope
    files: list[SkillFile] = field(default_factory=list)
    teamIds: list[str] | None = None


@dataclass(frozen=True)
class McpEnvVar:
    key: str
    type: Literal["plain_text", "secret", "boolean", "number"] = "plain_text"
    value: str | None = None
    promptOnInstallation: bool = False
    required: bool = False
    description: str | None = None


@dataclass(frozen=True)
class LocalConfig:
    command: str
    arguments: list[str] = field(default_factory=list)
    environment: list[McpEnvVar] = field(default_factory=list)


@dataclass(frozen=True)
class CatalogCreate:
    name: str
    serverType: ServerType
    scope: Scope
    description: str | None = None
    serverUrl: str | None = None
    localConfig: LocalConfig | None = None
    teams: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class McpInstall:
    catalogId: str
    name: str
    scope: Scope
    environmentValues: dict[str, str] = field(default_factory=dict)
    agentIds: list[str] = field(default_factory=list)
    teamId: str | None = None


@dataclass(frozen=True)
class LlmKeyCreate:
    provider: Provider
    scope: Scope
    apiKey: str
    name: str | None = None
    baseUrl: str | None = None
    isPrimary: bool | None = None
    teamId: str | None = None


@dataclass(frozen=True)
class PolicyCondition:
    key: str
    operator: ConditionOperator
    value: str


@dataclass(frozen=True)
class ToolInvocationPolicyCreate:
    toolId: str
    conditions: list[PolicyCondition]
    action: PolicyAction
    reason: str | None = None


@dataclass(frozen=True)
class HookCreate:
    agentId: str
    event: HookEvent
    fileName: str
    content: str
    requirements: list[str] = field(default_factory=list)
    enabled: bool = True


def to_payload(obj: object) -> dict[str, JsonValue]:
    """serialize a payload dataclass to a JSON body, recursively dropping None-valued keys
    (matching pydantic's exclude_none) while preserving False/0/empty-list/empty-dict."""
    body = require_dict(_drop_none(to_jsonable(obj)), ctx="payload")
    return body


def _drop_none(value: JsonValue) -> JsonValue:
    match value:
        case dict():
            return {k: _drop_none(v) for k, v in value.items() if v is not None}
        case list():
            return [_drop_none(v) for v in value]
        case _:
            return value


# --- errors --------------------------------------------------------------------------------


class ArchestraApiError(RuntimeError):
    """a non-2xx response (or an unexpected redirect). carries the full body."""

    def __init__(self, method: str, url: str, status: int, body: str) -> None:
        super().__init__(f"{method} {url} -> {status}: {body}")
        self.method = method
        self.url = url
        self.status = status
        self.body = body


class _RaiseOnRedirect(urllib.request.HTTPRedirectHandler):
    """turn any 3xx into an HTTPError instead of following it -- a redirect on a fixed,
    user-supplied base URL is unexpected and must not silently rewrite a POST to a GET."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


# --- client --------------------------------------------------------------------------------


class ArchestraClient:
    """talks to a single archestra instance. auth is either a session cookie (after sign_in)
    or an api key sent as the raw Authorization header (no Bearer)."""

    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout = timeout
        self._auth = api_key
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar),
            _RaiseOnRedirect(),
        )

    def __enter__(self) -> "ArchestraClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self._opener.close()

    def _url(self, path: str, params: dict[str, str] | None = None) -> str:
        url = urllib.parse.urljoin(self.base_url, path.lstrip("/"))
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        return url

    def _request(
        self, method: str, path: str, *,
        params: dict[str, str] | None = None,
        json_body: dict[str, JsonValue] | None = None,
    ) -> JsonValue:
        url = self._url(path, params)
        headers = {"Accept-Encoding": "identity"}  # no gzip we won't decode
        if self._auth:
            headers["Authorization"] = self._auth
        data: bytes | None = None
        if json_body is not None:
            # allow_nan=False: a NaN/inf field is a programming error, not valid JSON -- fail
            # loudly here rather than emit a body the server silently rejects.
            data = json.dumps(json_body, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return _decode_body(resp.read(), resp.headers)
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError(method, url, exc.code, _decode_error(exc)) from exc
        except (OSError, http.client.HTTPException, LookupError, json.JSONDecodeError) as exc:
            # transport/decode failure with no HTTP status (URLError is an OSError; LookupError
            # is an unknown charset; JSONDecodeError is a non-JSON body). status 0 keeps
            # wait_ready polling (it is not a 4xx) and lets apply.py record a `failed` op.
            raise ArchestraApiError(method, url, 0, f"{type(exc).__name__}: {exc}") from exc

    # --- connectivity & auth ---------------------------------------------------------------

    def wait_ready(self, timeout_s: float = 180.0, interval_s: float = 3.0) -> dict[str, JsonValue]:
        """poll GET /ready until the database is connected. raises on timeout."""
        deadline = time.monotonic() + timeout_s
        last = "no response"
        while time.monotonic() < deadline:
            try:
                body = self._request("GET", "ready")
            except ArchestraApiError as exc:
                # a 4xx is a misconfiguration (wrong base URL / auth) -> fail fast, don't spin.
                # 5xx and transport errors (status 0) are transient during boot -> keep polling.
                if 400 <= exc.status < 500:
                    raise
                last = str(exc)
            else:
                if isinstance(body, dict) and body.get("database") == "connected":
                    return body
                last = f"reachable but not connected: {body}"
            time.sleep(interval_s)
        raise TimeoutError(f"archestra not ready after {timeout_s}s; last: {last}")

    def sign_in(self, email: str, password: str) -> None:
        """better-auth email sign-in; the session cookie persists on this client's jar."""
        _require_secure_transport(self.base_url)
        self._request("POST", "/api/auth/sign-in/email", json_body={"email": email, "password": password})

    def mint_api_key(self, name: str) -> str:
        """create an api key for the signed-in user and switch this client to use it.
        the key value is only returned once by the server."""
        body = require_dict(
            self._request("POST", "/api/api-keys", json_body={"name": name}),
            ctx="POST /api/api-keys",
        )
        key = require_str_field(body, "key", ctx="POST /api/api-keys")
        self._auth = key
        return key

    # --- agents ----------------------------------------------------------------------------

    def list_agents(self, name: str | None = None, scope: Scope | None = None) -> list[dict[str, JsonValue]]:
        params = {k: v for k, v in {"name": name, "scope": scope}.items() if v is not None}
        return _items(self._request("GET", "/api/agents", params=params))

    def create_agent(self, payload: AgentCreate) -> dict[str, JsonValue]:
        return require_dict(self._request("POST", "/api/agents", json_body=to_payload(payload)),
                            ctx="POST /api/agents")

    # --- skills ----------------------------------------------------------------------------

    def list_skills(self, search: str | None = None) -> list[dict[str, JsonValue]]:
        params = {"search": search} if search else {}
        return _items(self._request("GET", "/api/skills", params=params))

    def create_skill(self, payload: SkillCreate) -> dict[str, JsonValue]:
        return require_dict(self._request("POST", "/api/skills", json_body=to_payload(payload)),
                            ctx="POST /api/skills")

    def enable_skill_defaults(self) -> None:
        """enable org skill tools (list_skills/load_skill) and backfill
        them onto existing agents. idempotent."""
        self._request("POST", "/api/skills/enable-defaults")

    # --- mcp catalog & install -------------------------------------------------------------

    def list_catalog(self) -> list[dict[str, JsonValue]]:
        return _items(self._request("GET", "/api/internal_mcp_catalog"))

    def create_catalog_item(self, payload: CatalogCreate) -> dict[str, JsonValue]:
        return require_dict(self._request("POST", "/api/internal_mcp_catalog", json_body=to_payload(payload)),
                            ctx="POST /api/internal_mcp_catalog")

    def list_mcp_servers(self, catalog_id: str | None = None) -> list[dict[str, JsonValue]]:
        params = {"catalogId": catalog_id} if catalog_id else {}
        return _items(self._request("GET", "/api/mcp_server", params=params))

    def install_mcp_server(self, payload: McpInstall) -> dict[str, JsonValue]:
        return require_dict(self._request("POST", "/api/mcp_server", json_body=to_payload(payload)),
                            ctx="POST /api/mcp_server")

    # --- llm provider keys -----------------------------------------------------------------

    def list_llm_keys(self, search: str | None = None, provider: Provider | None = None) -> list[dict[str, JsonValue]]:
        params = {k: v for k, v in {"search": search, "provider": provider}.items() if v is not None}
        return _items(self._request("GET", "/api/llm-provider-api-keys", params=params))

    def create_llm_key(self, payload: LlmKeyCreate) -> dict[str, JsonValue]:
        return require_dict(self._request("POST", "/api/llm-provider-api-keys", json_body=to_payload(payload)),
                            ctx="POST /api/llm-provider-api-keys")

    # --- tools & policies ------------------------------------------------------------------

    def list_tools(self, search: str | None = None) -> list[dict[str, JsonValue]]:
        params = {"search": search} if search else {}
        return _items(self._request("GET", "/api/tools", params=params))

    def bulk_assign_tools(self, assignments: list[dict[str, JsonValue]]) -> dict[str, JsonValue]:
        return require_dict(
            self._request("POST", "/api/agents/tools/bulk-assign", json_body={"assignments": assignments}),
            ctx="POST /api/agents/tools/bulk-assign",
        )

    def list_tool_invocation_policies(self, tool_id: str | None = None) -> list[dict[str, JsonValue]]:
        items = _items(self._request("GET", "/api/autonomy-policies/tool-invocation"))
        return [p for p in items if tool_id is None or p.get("toolId") == tool_id]

    def create_tool_invocation_policy(self, payload: ToolInvocationPolicyCreate) -> dict[str, JsonValue]:
        return require_dict(
            self._request("POST", "/api/autonomy-policies/tool-invocation", json_body=to_payload(payload)),
            ctx="POST /api/autonomy-policies/tool-invocation",
        )

    # --- lifecycle hooks -------------------------------------------------------------------

    def list_hooks(self, agent_id: str) -> list[dict[str, JsonValue]]:
        return _items(self._request("GET", "/api/hooks", params={"agentId": agent_id}))

    def create_hook(self, payload: HookCreate) -> dict[str, JsonValue]:
        return require_dict(self._request("POST", "/api/hooks", json_body=to_payload(payload)),
                            ctx="POST /api/hooks")

    def agent_hooks_enabled(self) -> bool:
        """whether the instance's agent-hooks feature is on (env flag AND the sandbox runtime).
        When off, POST /api/hooks still persists hooks but they never fire and are hidden in the UI."""
        config = require_dict(self._request("GET", "/api/config"), ctx="GET /api/config")
        features = config.get("features")
        return bool(features.get("agentHooksEnabled")) if isinstance(features, dict) else False


# --- response decoding & shape helpers -----------------------------------------------------


def _decode_body(raw: bytes, headers: http.client.HTTPMessage) -> JsonValue:
    charset = headers.get_content_charset() or "utf-8"
    text = raw.decode(charset, errors="replace")
    if headers.get_content_type() == "application/json":
        return json.loads(text) if text.strip() else None
    return text


def _decode_error(exc: urllib.error.HTTPError) -> str:
    raw = exc.read()
    charset = exc.headers.get_content_charset() if exc.headers else None
    return raw.decode(charset or "utf-8", errors="replace")


def _items(body: JsonValue) -> list[dict[str, JsonValue]]:
    """unwrap a list endpoint's response (bare array or {items|data: [...]} envelope).

    raises loudly on an unrecognized shape rather than returning [] -- a silent empty list
    would make idempotency checks miss existing entities and create duplicates. existence
    checks always pass a name/search filter, so results stay within one page; pagination
    beyond the first page is therefore not followed here by design.
    """
    match body:
        case list():
            rows = body
        case {"items": list() as items}:
            rows = items
        case {"data": list() as items}:
            rows = items
        case _:
            raise ContractError(f"unexpected list-response shape: {type(body).__name__}: {str(body)[:200]}")
    out: list[dict[str, JsonValue]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ContractError(f"unexpected list item (not an object): {type(row).__name__}")
        out.append(row)
    return out


def _require_secure_transport(base_url: str) -> None:
    """refuse to send sign-in credentials over a cleartext channel. https is always allowed;
    plain http is allowed only for loopback (local docker), where there is no network exposure."""
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme == "https":
        return
    if (parsed.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}:
        return
    raise ValueError(
        f"refusing to send sign-in credentials over insecure transport: {base_url!r} "
        "(use https, or localhost/127.0.0.1 for local docker)"
    )
