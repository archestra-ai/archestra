# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""chat-driving + skill-import extensions to the migration-kit ArchestraClient.

the benchmark reuses the zero-dependency migration-kit client verbatim (auth, request
plumbing, typed create_* payloads) and subclasses it here -- so the shipped migration skill
gains no benchmark-only code, and we still talk to one real archestra instance over HTTP.

the capabilities the migration client doesn't need but the eval does:
  - create_conversation: open a chat conversation bound to an agent (gives a conversationId,
    which is what makes the per-conversation skill sandbox + skill activation + attachment
    staging engage -- the A2A path can't thread one).
  - stream_chat_records: POST /api/chat and yield the server-driven model+tool loop's streamed
    UI-message events to completion (the harness folds them into a ChatRunResult per stage).
  - discover/import_github_skills: seed an environment's skills from a public GitHub repo, pinned.
"""

from __future__ import annotations

import base64
import functools
import http.client
import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Literal

from archestra_client import ArchestraApiError, ArchestraClient, _items
from contracts import JsonValue, require_dict

# an agent run drives a full model+tool loop; it takes minutes, not the client's default 30s.
DEFAULT_CHAT_TIMEOUT_S = 1800.0


@dataclass(frozen=True)
class FilePart:
    """an input file delivered inline in the chat message. the backend turns it into a
    conversation attachment that auto-stages into the sandbox under /home/sandbox/attachments/
    on the agent's first run_command."""

    filename: str
    mime_type: str
    data: bytes

    def to_data_url_part(self) -> dict[str, JsonValue]:
        b64 = base64.b64encode(self.data).decode("ascii")
        return {
            "type": "file",
            "url": f"data:{self.mime_type};base64,{b64}",
            "filename": self.filename,
            "mediaType": self.mime_type,
        }


@dataclass
class ChatRunResult:
    """outcome of one agent turn driven to completion."""

    text: str  # accumulated final assistant text
    tool_calls: list[str] = field(default_factory=list)  # tool names the model invoked, in order
    tool_invocations: list[dict[str, JsonValue]] = field(default_factory=list)  # {name, input} per call
    turn_count: int = 0  # model steps (one LLM call each), counted from stream step boundaries
    finish_reason: str | None = None
    total_tokens: int | None = None  # summed across stages; folded from stage_tokens at each stage end
    stage_tokens: int | None = None  # latest usage in the current stage's stream (the onFinish total)
    stream_error: str | None = None  # an error event surfaced mid-stream (run did not finish clean)


@dataclass(frozen=True)
class ChatStreamRecord:
    """One observable chat stream line after SSE parsing."""

    kind: Literal["event", "ignored", "parse_error"]
    event: dict[str, JsonValue] | None = None
    raw: str | None = None
    reason: str | None = None


class EvalClient(ArchestraClient):
    """ArchestraClient plus the chat + sandbox-file calls the benchmark needs."""

    def __enter__(self) -> "EvalClient":
        return self

    def sibling(self) -> "EvalClient":
        """A fresh client to the same backend + auth, so concurrent lanes sharing one backend don't
        share a single client's mutable state (its timeout, cookie jar, and opener)."""
        return EvalClient(self.base_url, api_key=self._auth, timeout=self.timeout)

    # --- models ----------------------------------------------------------------------------

    def list_models(self) -> list[dict[str, JsonValue]]:
        """all synced LLM models with their linked provider api keys. each row's `id` is the
        UUID used as a conversation's `modelId`; `modelId` is the provider model name."""
        return _items(self._request("GET", "/api/llm-models"))

    def sync_models(self) -> None:
        """force a model sync across the user's provider keys (key creation also triggers one)."""
        self._request("POST", "/api/llm-models/sync")

    # --- skills & tools ---------------------------------------------------------------------

    def discover_github_skills(
        self, repo_url: str, *, path: str | None = None, ref: str | None = None
    ) -> list[dict[str, JsonValue]]:
        """list the skills a public GitHub repo exposes (each has a `skillPath`).

        `ref` pins to a commit/branch/tag via GitHub's `/tree/<ref>` URL form (the backend resolves
        it through getCommit), so the imported surface is reproducible."""
        body: dict[str, JsonValue] = {"repoUrl": _pin_repo_url(repo_url, ref)}
        if path is not None:
            body["path"] = path
        _with_github_token(body)
        result = require_dict(
            self._request("POST", "/api/skills/github/discover", json_body=body),
            ctx="POST /api/skills/github/discover",
        )
        skills = result.get("skills")
        return [s for s in skills if isinstance(s, dict)] if isinstance(skills, list) else []

    def import_github_skills(
        self, repo_url: str, skill_paths: list[str], *, scope: str = "org", ref: str | None = None,
        timeout_s: float = 600.0,
    ) -> dict[str, JsonValue]:
        """import the named skills from a public GitHub repo into the skill library, optionally
        pinned to a commit/branch/tag `ref` (see `discover_github_skills`).

        the backend fetches every skill's files from GitHub synchronously, so importing a whole
        library takes minutes -- well past the client's default 30s. raise the timeout for this one
        call (restored after) so a large import does not spuriously time out, while other calls keep
        failing fast."""
        body: dict[str, JsonValue] = {
            "repoUrl": _pin_repo_url(repo_url, ref),
            "skillPaths": skill_paths,
            "scope": scope,
        }
        _with_github_token(body)
        prev_timeout = self.timeout
        self.timeout = max(prev_timeout, timeout_s)
        try:
            return require_dict(
                self._request("POST", "/api/skills/github/import", json_body=body),
                ctx="POST /api/skills/github/import",
            )
        finally:
            self.timeout = prev_timeout

    def list_agent_tools(self, agent_id: str) -> list[dict[str, JsonValue]]:
        return _items(self._request("GET", f"/api/agents/{agent_id}/tools"))

    def install_mcp(
        self, *, name: str, catalog_id: str, scope: str = "org", agent_ids: list[str] | None = None
    ) -> dict[str, JsonValue]:
        """install a catalog MCP server. unlike the migration client's McpInstall, the install body
        requires a `name`; remote servers discover their tools synchronously here."""
        body: dict[str, JsonValue] = {"name": name, "catalogId": catalog_id, "scope": scope}
        if agent_ids:
            body["agentIds"] = agent_ids
        return require_dict(self._request("POST", "/api/mcp_server", json_body=body), ctx="POST /api/mcp_server")

    def list_mcp_server_tools(self, server_id: str) -> list[dict[str, JsonValue]]:
        return _items(self._request("GET", f"/api/mcp_server/{server_id}/tools"))

    def unassign_tool(self, agent_id: str, tool_id: str) -> None:
        self._request("DELETE", f"/api/agents/{agent_id}/tools/{tool_id}")

    def get_json(self, path: str) -> JsonValue:
        """authenticated GET returning the decoded JSON body, for out-of-band state capture.

        the path is a relative backend route (validated at task load, see tasks._state_path); the
        decoded value is whatever the endpoint returns (a paginated `{data, pagination}`, an
        `{items}` list, etc.) and is handed to the verifier verbatim as BENCH_STATE."""
        return self._request("GET", path)

    # --- conversations & chat --------------------------------------------------------------

    def create_conversation(self, agent_id: str, *, title: str | None = None,
                            model_id: str | None = None,
                            chat_api_key_id: str | None = None) -> dict[str, JsonValue]:
        body: dict[str, JsonValue] = {"agentId": agent_id}
        if title is not None:
            body["title"] = title
        if model_id is not None:
            body["modelId"] = model_id
        if chat_api_key_id is not None:
            body["chatApiKeyId"] = chat_api_key_id
        return require_dict(self._request("POST", "/api/chat/conversations", json_body=body),
                            ctx="POST /api/chat/conversations")

    def stream_chat_records(self, conversation_id: str, *, text: str, files: tuple[FilePart, ...] = (),
                            timeout_s: float = DEFAULT_CHAT_TIMEOUT_S) -> Iterator[ChatStreamRecord]:
        """Send one user message and yield every parsed/ignored chat stream record."""
        parts: list[dict[str, JsonValue]] = [{"type": "text", "text": text}]
        parts.extend(part.to_data_url_part() for part in files)
        body: dict[str, JsonValue] = {
            "id": conversation_id,
            "messages": [{"id": str(uuid.uuid4()), "role": "user", "parts": parts}],
            "trigger": "submit-message",
        }
        yield from self._stream_chat_records(body, timeout_s)

    def warm_user_token(self) -> None:
        """Materialize the per-(user,org) MCP gateway token before concurrent chats race to create it.

        `GET /api/user-tokens/me` calls the backend's `ensureUserToken` (creating it if absent) with no
        LLM call. On a shared backend the first `/api/chat` of every lane otherwise races this check-
        then-insert; doing it once, serially, up front means all later chats hit the existing token."""
        self._request("GET", "/api/user-tokens/me")

    # --- conversation files ----------------------------------------------------------------

    def list_conversation_files(self, conversation_id: str) -> dict[str, JsonValue]:
        """list a conversation's files: `generated` (artifacts the agent exported via download_file)
        and `attachments` (files the user staged). Each entry carries a `name` and `contentUrl`."""
        return require_dict(
            self._request("GET", f"/api/chat/conversations/{conversation_id}/files"),
            ctx=f"GET /api/chat/conversations/{conversation_id}/files",
        )

    def download_file_bytes(self, content_url: str, *, timeout_s: float = 120.0) -> bytes:
        """raw authenticated GET returning the response body untouched as bytes.

        bypasses ArchestraClient._request/_decode_body (which coerces a non-JSON body to text and
        would corrupt binary artifacts) so a zip/gif/xlsx is returned byte-exact."""
        url = self._url(content_url)
        headers = {"Accept-Encoding": "identity"}
        if self._auth:
            headers["Authorization"] = self._auth
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with self._opener.open(req, timeout=timeout_s) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError("GET", url, exc.code, _read_error_body(exc)) from exc
        except OSError as exc:
            raise ArchestraApiError("GET", url, 0, f"{type(exc).__name__}: {exc}") from exc

    # --- internal --------------------------------------------------------------------------

    def _stream_chat_records(self, body: dict[str, JsonValue], timeout_s: float) -> Iterator[ChatStreamRecord]:
        """POST /api/chat and yield every observed SSE data record."""
        url = self._url("/api/chat")
        headers = {"Accept-Encoding": "identity", "Content-Type": "application/json",
                   "Accept": "text/event-stream"}
        if self._auth:
            headers["Authorization"] = self._auth
        data = json.dumps(body, allow_nan=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            resp = self._opener.open(req, timeout=timeout_s)
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError("POST", url, exc.code, _read_error_body(exc)) from exc
        except OSError as exc:
            raise ArchestraApiError("POST", url, 0, f"{type(exc).__name__}: {exc}") from exc
        with resp:
            try:
                for raw in resp:
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    payload = _sse_data_payload(line)
                    if payload is None:
                        if line:
                            yield ChatStreamRecord(kind="ignored", raw=line, reason="non-data line")
                        continue
                    if payload == "[DONE]":
                        yield ChatStreamRecord(kind="ignored", raw=line, reason="done")
                        continue
                    if payload == "":
                        yield ChatStreamRecord(kind="ignored", raw=line, reason="empty data payload")
                        continue
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError as exc:
                        yield ChatStreamRecord(kind="parse_error", raw=line, reason=str(exc))
                        continue
                    if isinstance(event, dict):
                        yield ChatStreamRecord(kind="event", event=event)
                    else:
                        yield ChatStreamRecord(kind="ignored", raw=line, reason="non-object JSON payload")
            except (OSError, http.client.HTTPException) as exc:
                # the stream dropped mid-read (connection reset, truncated chunk, timeout); surface it
                # like an open failure so _drive_stage records one agent_error cell, not a batch crash.
                raise ArchestraApiError(
                    "POST", url, 0, f"chat stream interrupted: {type(exc).__name__}: {exc}"
                ) from exc


def _sse_data_payload(line: str) -> str | None:
    """extract the JSON payload from one SSE line, or None for non-data lines."""
    if not line.startswith("data:"):
        return None
    return line[len("data:"):].strip()


def _apply_chat_event(result: ChatRunResult, event: dict[str, JsonValue]) -> None:
    """fold one stream event into the accumulating result. tolerant of the AI-SDK text-delta
    field name (`delta` in v5; some paths emit `text`)."""
    match event.get("type"):
        case "start-step":
            result.turn_count += 1
        case "text-delta":
            delta = event.get("delta")
            if not isinstance(delta, str):
                delta = event.get("text")
            if isinstance(delta, str):
                result.text += delta
        case "tool-input-available" | "tool-call":
            name = event.get("toolName")
            if isinstance(name, str):
                result.tool_calls.append(name)
                result.tool_invocations.append({"name": name, "input": event.get("input")})
        case "finish" | "finish-step":
            reason = event.get("finishReason")
            if isinstance(reason, str):
                result.finish_reason = reason
        case "data-token-usage":
            # The backend emits one of these per step (onStepFinish) then a final terminal event
            # carrying the AI-SDK aggregate usage. The last value is thus the stage total -- relay it;
            # summing every event would double-count the per-step ones. (A flaky gateway may under-
            # report its aggregate; relaying the provider's own number is the honest choice.)
            # _drive_stage folds this per-stage total into the run total.
            usage = event.get("data")
            if isinstance(usage, dict) and isinstance(usage.get("totalTokens"), int):
                result.stage_tokens = usage["totalTokens"]
        case "error":
            text = event.get("errorText") or event.get("error")
            result.stream_error = text if isinstance(text, str) else json.dumps(event)


def _read_error_body(exc: urllib.error.HTTPError) -> str:
    raw = exc.read()
    charset = exc.headers.get_content_charset() if exc.headers else None
    return raw.decode(charset or "utf-8", errors="replace")


def _pin_repo_url(repo_url: str, ref: str | None) -> str:
    """Pin a GitHub repo URL to a ref using the `/tree/<ref>` form the backend's parseRepoUrl reads."""
    if ref is None:
        return repo_url
    return f"{repo_url.rstrip('/')}/tree/{ref}"


def _with_github_token(body: dict[str, JsonValue]) -> None:
    """Attach a transient GitHub PAT so ref resolution + file fetches use the authenticated rate limit
    (5000/h) instead of the unauthenticated 60/h that trips on big repos. Falls back to the local `gh`
    CLI's active token, so a logged-in `gh` needs no env var."""
    token = _github_token()
    if token:
        body["githubToken"] = token


@functools.cache
def _github_token() -> str | None:
    env = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env:
        return env
    if not shutil.which("gh"):
        return None
    try:
        out = subprocess.run(  # noqa: S603 -- fixed argv, no shell
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=10, check=True
        )
    except (subprocess.SubprocessError, OSError):
        return None
    return out.stdout.strip() or None
