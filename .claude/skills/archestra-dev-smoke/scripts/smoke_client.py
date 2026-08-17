# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""stdlib-only client for driving a live archestra instance during smoke testing.

scope: the few calls needed to run one real chat turn end to end and read the result back --
auth, agent lookup, conversation create, the streaming chat turn, and the persisted read-back
(messages + the llm interaction's tokens/cost). it is NOT a general api client; for the broader
surface (skills, mcp, policies, hooks) use migration-kit/scripts/archestra_client.py.

the request/error/cookie plumbing follows that sibling client: a private opener owns a cookie jar
so the session cookie from sign_in carries forward, redirects are treated as errors (a redirect on
a fixed base url could silently rewrite a POST), and every non-2xx raises ArchestraApiError verbatim.

the chat turn cannot reuse the json _request path: POST /api/chat returns an open AI-SDK UIMessage
stream, so it has its own streaming request that drains the body with a hard read+wall-clock
deadline (a stalled llm call must fail loudly, never hang). stream bytes are opaque -- the
authoritative result is the persisted conversation read back afterward, not reconstructed chunks.
"""

from __future__ import annotations

import http.client
import http.cookiejar
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass

JsonValue = object  # the api returns arbitrary json; callers narrow with isinstance/require_*


class ArchestraApiError(RuntimeError):
    """a non-2xx response (or an unexpected redirect / transport failure). carries the body."""

    def __init__(self, method: str, url: str, status: int, body: str) -> None:
        super().__init__(f"{method} {url} -> {status}: {body}")
        self.method = method
        self.url = url
        self.status = status
        self.body = body


class ChatTurnError(RuntimeError):
    """the chat turn itself failed: an error frame in the stream, a drain timeout, or no
    assistant message persisted within the read-back window. distinct from ArchestraApiError
    (an http-level failure) so chat_turn.py can report the turn outcome separately."""


@dataclass(frozen=True)
class ChatTurnResult:
    conversation_id: str
    text: str
    tool_calls: list[str]
    input_tokens: int | None
    output_tokens: int | None
    cost: float | None
    model: str | None


class _RaiseOnRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


class SmokeClient:
    """talks to one running archestra instance. auth is either an api key (raw Authorization
    header, no Bearer) or a better-auth session cookie established by sign_in."""

    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout = timeout
        # an api key is a credential too: refuse to attach it over cleartext non-loopback
        # transport, the same guard sign_in applies to a password.
        if api_key is not None:
            _require_secure_transport(self.base_url)
        self._auth = api_key
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar),
            _RaiseOnRedirect(),
        )

    def __enter__(self) -> "SmokeClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self._opener.close()

    # --- auth & connectivity ---------------------------------------------------------------

    def sign_in(self, email: str, password: str) -> None:
        """better-auth email sign-in; the session cookie persists on this client's jar."""
        _require_secure_transport(self.base_url)
        self._request("POST", "/api/auth/sign-in/email", json_body={"email": email, "password": password})

    def connect_check(self) -> dict[str, JsonValue]:
        """authed probe that proves frontend + backend + db + our credential all work. /ready and
        /health live on the backend origin only, so an authed /api route is the real local gate."""
        return _require_dict(self._request("GET", "/api/config"), ctx="GET /api/config")

    # --- agents & keys (read-only; the skill never mutates keys) ----------------------------

    def list_agents(self, name: str | None = None) -> list[dict[str, JsonValue]]:
        """pass `name` to filter server-side: /api/agents is paginated (default 20 rows), so an
        unfiltered list would silently miss agents on a larger instance."""
        params = {"name": name} if name else None
        return _items(self._request("GET", "/api/agents", params=params))

    def list_llm_keys(self) -> list[dict[str, JsonValue]]:
        """only used to enrich the 'no llm key configured' diagnostic when a turn fails."""
        return _items(self._request("GET", "/api/llm-provider-api-keys"))

    # --- one chat turn, end to end ----------------------------------------------------------

    def create_conversation(
        self, agent_id: str, *, title: str | None = None, model_id: str | None = None
    ) -> str:
        """create a conversation bound to an agent. modelId is optional -- the backend resolves
        member -> agent -> org -> best-available, so omit it unless explicitly overriding."""
        body: dict[str, JsonValue] = {"agentId": agent_id}
        if title is not None:
            body["title"] = title
        if model_id is not None:
            body["modelId"] = model_id
        created = _require_dict(
            self._request("POST", "/api/chat/conversations", json_body=body),
            ctx="POST /api/chat/conversations",
        )
        return _require_str(created, "id", ctx="conversation create response")

    def run_turn(
        self,
        agent_id: str,
        prompt: str,
        *,
        title: str | None = None,
        model_id: str | None = None,
        stream_timeout_s: float = 180.0,
        readback_timeout_s: float = 20.0,
    ) -> ChatTurnResult:
        """create a conversation, send one user message, drain the stream, then read the
        persisted assistant message + interaction back. raises ChatTurnError on any turn failure."""
        conversation_id = self.create_conversation(agent_id, title=title, model_id=model_id)
        stream_error = self._send_message(conversation_id, prompt, timeout_s=stream_timeout_s)
        if stream_error is not None:
            raise ChatTurnError(f"chat stream returned an error: {stream_error}")
        text, tool_calls = self._read_assistant_reply(conversation_id, timeout_s=readback_timeout_s)
        interactions = self._session_interactions(conversation_id)
        return ChatTurnResult(
            conversation_id=conversation_id,
            text=text,
            tool_calls=tool_calls,
            # a tool-loop turn issues several llm calls, each its own interaction row -- sum them
            # so the reported usage is the whole turn, not just the final step.
            input_tokens=_sum_int(interactions, "inputTokens"),
            output_tokens=_sum_int(interactions, "outputTokens"),
            cost=_sum_float(interactions, "cost"),
            model=_opt_str(interactions[0] if interactions else None, "model"),
        )

    # --- internals --------------------------------------------------------------------------

    def _send_message(self, conversation_id: str, prompt: str, *, timeout_s: float) -> str | None:
        """POST /api/chat and drain the AI-SDK stream to completion. returns an error string if
        the stream carried an error frame, else None. raises ChatTurnError on a drain timeout."""
        body = {
            "id": conversation_id,
            "messages": [{"id": str(uuid.uuid4()), "role": "user", "parts": [{"type": "text", "text": prompt}]}],
            "trigger": "submit-message",
        }
        req = self._build_request("POST", "/api/chat", json_body=body)
        deadline = time.monotonic() + timeout_s
        # the socket timeout is the whole turn budget, not a tight per-chunk window: a tool-using or
        # reasoning turn can legitimately go quiet for many seconds between chunks, and treating that
        # as a stall is a false failure. the budget caps both a single dead read and (via the
        # post-read deadline check) the turn overall.
        try:
            resp = self._opener.open(req, timeout=timeout_s)
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError("POST", req.full_url, exc.code, _decode_error(exc)) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise ArchestraApiError("POST", req.full_url, 0, f"{type(exc).__name__}: {exc}") from exc
        try:
            chunks: list[str] = []
            while True:
                try:
                    block = resp.read(8192)
                except socket.timeout as exc:
                    raise ChatTurnError(f"chat stream did not finish within {timeout_s:.0f}s") from exc
                if not block:
                    break
                chunks.append(block.decode("utf-8", errors="replace"))
                if time.monotonic() > deadline:
                    raise ChatTurnError(f"chat stream did not finish within {timeout_s:.0f}s")
            return _scan_stream_error("".join(chunks))
        finally:
            resp.close()

    def _read_assistant_reply(self, conversation_id: str, *, timeout_s: float) -> tuple[str, list[str]]:
        """poll the persisted conversation for the assistant message. persistence happens in the
        backend onFinish, slightly after the stream ends, so this is a bounded retry not one read."""
        deadline = time.monotonic() + timeout_s
        while True:
            conversation = _require_dict(
                self._request("GET", f"/api/chat/conversations/{conversation_id}"),
                ctx="GET conversation",
            )
            messages = conversation.get("messages")
            messages = messages if isinstance(messages, list) else []
            for message in reversed(messages):
                if isinstance(message, dict) and message.get("role") == "assistant":
                    parts = message.get("parts")
                    # the read-back is post-drain, so a persisted assistant message with any parts
                    # is final. return it even if it has no text (e.g. a tool-only or file reply)
                    # rather than looping to a false "no reply" timeout.
                    if isinstance(parts, list) and parts:
                        return _extract_parts(parts)
            if time.monotonic() > deadline:
                raise ChatTurnError(
                    f"no assistant reply persisted within {timeout_s:.0f}s "
                    f"(conversation {conversation_id})"
                )
            time.sleep(1.0)

    def _session_interactions(self, conversation_id: str) -> list[dict[str, JsonValue]]:
        """conversationId is passed to the llm proxy as sessionId, so every llm call in the turn is
        retrievable by that filter (newest first). missing interactions are non-fatal -- the reply
        still stands; usage just reports unknown."""
        return _items(self._request("GET", "/api/interactions", params={"sessionId": conversation_id}))

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_body: dict[str, JsonValue] | None = None,
    ) -> JsonValue:
        req = self._build_request(method, path, params=params, json_body=json_body)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return _decode_body(resp.read(), resp.headers)
        except urllib.error.HTTPError as exc:
            raise ArchestraApiError(method, req.full_url, exc.code, _decode_error(exc)) from exc
        except (OSError, http.client.HTTPException, LookupError, json.JSONDecodeError) as exc:
            raise ArchestraApiError(method, req.full_url, 0, f"{type(exc).__name__}: {exc}") from exc

    def _build_request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_body: dict[str, JsonValue] | None = None,
    ) -> urllib.request.Request:
        url = urllib.parse.urljoin(self.base_url, path.lstrip("/"))
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        headers = {"Accept-Encoding": "identity"}
        if self._auth:
            headers["Authorization"] = self._auth
        data: bytes | None = None
        if json_body is not None:
            data = json.dumps(json_body, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        return urllib.request.Request(url, data=data, headers=headers, method=method)


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
    """unwrap a list endpoint (bare array or {data|items: [...]} envelope). raises on an
    unrecognized shape rather than hiding it as an empty list."""
    match body:
        case list():
            rows = body
        case {"data": list() as data}:
            rows = data
        case {"items": list() as data}:
            rows = data
        case _:
            raise ArchestraApiError("GET", "<list>", 0, f"unexpected list shape: {str(body)[:200]}")
    out: list[dict[str, JsonValue]] = []
    for row in rows:
        if isinstance(row, dict):
            out.append(row)
    return out


# AI-SDK v5 names a tool part 'tool-<actualToolName>'. the legacy generic 'tool-call'/'tool-result'
# types carry the name elsewhere, so naively stripping the prefix would report phantom tools named
# 'call'/'result'; skip them and let 'dynamic-tool' / typed parts carry the real names.
_LEGACY_TOOL_TYPES = frozenset({"tool-call", "tool-result"})


def _extract_parts(parts: JsonValue) -> tuple[str, list[str]]:
    """pull visible text and tool-call names out of a persisted assistant message's parts.
    AI-SDK tool parts are typed 'tool-<name>' (or a 'dynamic-tool' carrying toolName)."""
    text_segments: list[str] = []
    tool_calls: list[str] = []
    if not isinstance(parts, list):
        return "", []
    for part in parts:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "text" and isinstance(part.get("text"), str):
            text_segments.append(part["text"])
        elif part_type == "dynamic-tool" and isinstance(part.get("toolName"), str):
            tool_calls.append(part["toolName"])
        elif (
            isinstance(part_type, str)
            and part_type.startswith("tool-")
            and part_type not in _LEGACY_TOOL_TYPES
        ):
            tool_calls.append(part_type.removeprefix("tool-"))
    return "".join(text_segments).strip(), tool_calls


def _scan_stream_error(stream_text: str) -> str | None:
    """best-effort: surface an AI-SDK error frame from the drained stream. the stream is a series
    of `data: {json}` lines; an error part looks like {"type":"error","errorText":"..."}."""
    for line in stream_text.splitlines():
        line = line.strip()
        payload = line[len("data:"):].strip() if line.startswith("data:") else line
        if not payload.startswith("{") or '"error"' not in payload:
            continue
        try:
            frame = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(frame, dict) and frame.get("type") == "error":
            detail = frame.get("errorText") or frame.get("error") or frame
            return str(detail)
    return None


def _require_dict(value: JsonValue, *, ctx: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise ArchestraApiError("?", ctx, 0, f"expected an object, got {type(value).__name__}")
    return value


def _require_str(obj: dict[str, JsonValue], key: str, *, ctx: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise ArchestraApiError("?", ctx, 0, f"missing string field {key!r}")
    return value


def _opt_str(obj: dict[str, JsonValue] | None, key: str) -> str | None:
    value = obj.get(key) if obj else None
    return value if isinstance(value, str) else None


def _sum_int(rows: list[dict[str, JsonValue]], key: str) -> int | None:
    """sum an integer column across rows; None when no row carries it (unknown, not zero)."""
    values = [row[key] for row in rows if isinstance(row.get(key), int)]
    return sum(values) if values else None


def _sum_float(rows: list[dict[str, JsonValue]], key: str) -> float | None:
    """sum a numeric column across rows; None when no row carries it (unknown, not zero)."""
    values = [v for row in rows if (v := _coerce_float(row.get(key))) is not None]
    return sum(values) if values else None


def _coerce_float(value: JsonValue) -> float | None:
    """cost is a numeric column serialized as a decimal string; coerce it."""
    match value:
        case int() | float():
            return float(value)
        case str() if value.strip():
            try:
                return float(value)
            except ValueError:
                return None
        case _:
            return None


def _require_secure_transport(base_url: str) -> None:
    """refuse to send credentials over cleartext. https always; plain http only for loopback."""
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme == "https":
        return
    if (parsed.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}:
        return
    raise ValueError(
        f"refusing to send credentials over insecure transport: {base_url!r} "
        "(use https, or localhost/127.0.0.1 for local dev)"
    )


__all__ = ["SmokeClient", "ChatTurnResult", "ArchestraApiError", "ChatTurnError"]
