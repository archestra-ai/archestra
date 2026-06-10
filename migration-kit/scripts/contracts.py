# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""typed, zero-dependency contracts shared by discover.py and apply.py.

this module is the lowest layer: it depends only on the standard library, and both the
discoverer (which emits inventory.json) and the applier (which reads it back) share these
dataclasses so the cross-script JSON boundary is no longer ``dict[str, Any]``.

guarantees come from two places, since there is no pydantic at runtime:
  * static: ``ty``/``mypy`` over fully-typed dataclasses + Literals.
  * runtime: the ``parse_*`` functions below validate every value crossing a trust boundary
    (external JSON, model-authored answers, API responses) and raise ``ContractError`` with
    the offending path. nothing is silently coerced.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, fields, is_dataclass
from typing import Literal, Mapping, TypeVar, Union, cast

SCHEMA_VERSION = 1

# --- secret detection (single source, shared by discover redaction + apply env handling) --
# key names whose values must be treated as secrets. a credential word only counts as a
# delimited *component* of the key -- the boundary is a string end, a non-alphanumeric
# (``_``/``-``/``.``), or a camelCase hump -- so ``API_KEY``/``apiKey``/``access-token`` match
# but ``monkey``/``tokenize``/``secretary`` do not. the alternation is case-insensitive; the
# surrounding boundary classes are deliberately case-sensitive (camelCase detection).
SECRET_KEY_RE = re.compile(
    r"(?:^|[^A-Za-z0-9]|(?<=[a-z0-9])(?=[A-Z]))"
    r"(?i:(?:api[_-]?key|key|token|secret|passwd|password|authorization|credential)s?)"
    r"(?![a-z])"
)
# value shapes that look like credentials even under an innocuous key (anchored prefix).
SECRET_VALUE_RE = re.compile(r"^(sk-|gh[psoru]_|xox[baprs]-|AIza|ya29\.|eyJ[A-Za-z0-9_-]{10,})")
# credential-shaped tokens embedded anywhere inside a string (commands, prose, config values).
SECRET_TOKEN_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{8,}|gh[psoru]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}"
    r"|AIza[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)


def redact_tokens(text: str) -> str:
    """replace credential-shaped tokens embedded in a string (a hook command, an MCP launch
    command, a URL) before it is stored or printed."""
    return SECRET_TOKEN_RE.sub("<redacted>", text)

# --- shared Literal vocabularies (imported by archestra_client to avoid a cycle) ----------

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
ItemKind = Literal[
    "claude_md", "subagent", "skill", "command", "local_tool", "mcp_server", "hook", "openclaw"
]
TargetKind = Literal[
    "agent", "skill", "mcp_catalog", "mcp_install", "llm_key", "tool_policy", "hook"
]
Outcome = Literal["created", "skipped", "failed", "manual", "planned", "invalid"]
HookIntent = Literal["guard", "passive"]
# the three lifecycle events archestra runs hooks for (the rest have no native target).
HookEvent = Literal["session_start", "pre_tool_use", "post_tool_use"]
# how a discovered hook's script body was obtained: a bundled referenced file, an inline shell
# snippet to synthesize a wrapper from, or unresolvable (missing/escaping/unparsable -> manual).
HookSource = Literal["bundled", "inline", "unresolved"]

# archestra hook-file constraints (single source, mirrors InsertHookFileSchema in the backend).
HOOK_FILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.(py|sh)$")
HOOK_FILE_NAME_MAX = 255
HOOK_CONTENT_MAX = 65_536
HOOK_REQUIREMENTS_MAX = 20
HOOK_REQUIREMENT_MAX_LEN = 200
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def archestra_hook_event(claude_event: str) -> HookEvent | None:
    """map a Claude Code hook event name to its archestra lifecycle event, or None when archestra
    has no equivalent (UserPromptSubmit, Stop, SubagentStop, PreCompact, Notification, SessionEnd…)."""
    match claude_event:
        case "SessionStart":
            return "session_start"
        case "PreToolUse":
            return "pre_tool_use"
        case "PostToolUse":
            return "post_tool_use"
        case _:
            return None

# an arbitrary decoded-JSON value. used only where the schema is genuinely open (openclaw
# config, model-authored answer payloads); everything else is precisely typed.
JsonValue = Union[str, int, float, bool, None, list["JsonValue"], dict[str, "JsonValue"]]
# frontmatter, as produced by frontmatter.parse_frontmatter (scalars + simple lists only).
FrontMatterValue = Union[str, list[str]]
FrontMatter = dict[str, FrontMatterValue]


class ContractError(ValueError):
    """a value crossing a trust boundary failed validation. carries the JSON path."""


# --- per-kind item data ------------------------------------------------------------------


@dataclass(frozen=True)
class ClaudeMdData:
    body: str
    frontmatter: FrontMatter = field(default_factory=dict)


@dataclass(frozen=True)
class SubagentData:
    body: str
    description: str | None = None
    tools: str | list[str] | None = None


@dataclass(frozen=True)
class SkillData:
    content: str
    frontmatter: FrontMatter = field(default_factory=dict)


@dataclass(frozen=True)
class CommandData:
    body: str
    frontmatter: FrontMatter = field(default_factory=dict)


@dataclass(frozen=True)
class LocalToolData:
    entrypoint: str


@dataclass(frozen=True)
class McpServerData:
    transport: ServerType
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    url: str | None = None


@dataclass(frozen=True)
class HookData:
    event: str
    command: str
    intent: HookIntent
    source: HookSource
    matcher: str | None = None
    # set when source == "bundled": the referenced script's basename + source-relative path.
    file_name: str | None = None
    script_path: str | None = None
    # PEP-723 dependencies extracted from a bundled .py hook (empty otherwise / for bash).
    requirements: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class OpenclawData:
    # report-only; the openclaw schema is unverified, so the redacted config stays open.
    config: dict[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True)
class BundledFile:
    path: str
    content: str
    encoding: Literal["utf8", "base64"]


# --- items: a discriminated union so kind <-> data is correlated at the type level --------


@dataclass(frozen=True, kw_only=True)
class _ItemBase:
    id: str
    name: str
    path: str
    summary: str = ""
    files: list[BundledFile] = field(default_factory=list)
    redacted_refs: list[str] = field(default_factory=list)


@dataclass(frozen=True, kw_only=True)
class ClaudeMdItem(_ItemBase):
    data: ClaudeMdData
    kind: Literal["claude_md"] = "claude_md"


@dataclass(frozen=True, kw_only=True)
class SubagentItem(_ItemBase):
    data: SubagentData
    kind: Literal["subagent"] = "subagent"


@dataclass(frozen=True, kw_only=True)
class SkillItem(_ItemBase):
    data: SkillData
    kind: Literal["skill"] = "skill"


@dataclass(frozen=True, kw_only=True)
class CommandItem(_ItemBase):
    data: CommandData
    kind: Literal["command"] = "command"


@dataclass(frozen=True, kw_only=True)
class LocalToolItem(_ItemBase):
    data: LocalToolData
    kind: Literal["local_tool"] = "local_tool"


@dataclass(frozen=True, kw_only=True)
class McpServerItem(_ItemBase):
    data: McpServerData
    kind: Literal["mcp_server"] = "mcp_server"


@dataclass(frozen=True, kw_only=True)
class HookItem(_ItemBase):
    data: HookData
    kind: Literal["hook"] = "hook"


@dataclass(frozen=True, kw_only=True)
class OpenclawItem(_ItemBase):
    data: OpenclawData
    kind: Literal["openclaw"] = "openclaw"


Item = Union[
    ClaudeMdItem, SubagentItem, SkillItem, CommandItem,
    LocalToolItem, McpServerItem, HookItem, OpenclawItem,
]


@dataclass(frozen=True)
class Inventory:
    source_root: str
    schema_version: int = SCHEMA_VERSION
    items: list[Item] = field(default_factory=list)
    unknowns: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# --- migration plan + result -------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    source_id: str
    target_kind: TargetKind
    scope: Scope
    action: Literal["migrate", "skip", "manual"] = "migrate"
    name_override: str | None = None
    notes: str | None = None
    # model-authored; consumed ONLY through the require_* validators below, never raw.
    user_answers: dict[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True)
class MigrationPlan:
    schema_version: int
    default_scope: Scope
    decisions: list[Decision] = field(default_factory=list)


@dataclass(frozen=True)
class ResultOp:
    source_id: str
    target_kind: str
    name: str
    outcome: Outcome
    archestra_id: str | None = None
    error: str | None = None
    detail: str | None = None


# --- generic JSON readers (raise loudly, never coerce) -----------------------------------


def require_dict(value: object, *, ctx: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise ContractError(f"{ctx}: expected an object, got {type(value).__name__}")
    # JSON object keys are always strings and values are JsonValue (this is only ever called
    # on json.loads output or dataclass asdict output); assert that for the type system.
    return cast("dict[str, JsonValue]", value)


def require_list(value: object, *, ctx: str) -> list[JsonValue]:
    if not isinstance(value, list):
        raise ContractError(f"{ctx}: expected an array, got {type(value).__name__}")
    return cast("list[JsonValue]", value)


def as_object(value: JsonValue) -> dict[str, JsonValue] | None:
    """typed, non-raising view of a JSON value as an object (or None). use for best-effort
    parsing where a malformed shape should be skipped rather than rejected."""
    return cast("dict[str, JsonValue]", value) if isinstance(value, dict) else None


def as_array(value: JsonValue) -> list[JsonValue] | None:
    """typed, non-raising view of a JSON value as an array (or None)."""
    return cast("list[JsonValue]", value) if isinstance(value, list) else None


def require_str_field(obj: Mapping[str, JsonValue], key: str, *, ctx: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise ContractError(f"{ctx}: field {key!r} must be a non-empty string, got {value!r}")
    return value


def _opt_str(obj: Mapping[str, JsonValue], key: str, *, ctx: str) -> str | None:
    value = obj.get(key)
    match value:
        case None:
            return None
        case str():
            return value
        case _:
            raise ContractError(f"{ctx}: field {key!r} must be a string or absent, got {value!r}")


def _str_list(value: object, *, ctx: str) -> list[str]:
    out: list[str] = []
    for i, item in enumerate(require_list(value, ctx=ctx)):
        if not isinstance(item, str):
            raise ContractError(f"{ctx}[{i}]: expected string, got {type(item).__name__}")
        out.append(item)
    return out


def _str_map(value: object, *, ctx: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, item in require_dict(value, ctx=ctx).items():
        if not isinstance(item, str):
            raise ContractError(f"{ctx}.{key}: expected string value, got {type(item).__name__}")
        out[key] = item
    return out


def _frontmatter(value: object, *, ctx: str) -> FrontMatter:
    out: FrontMatter = {}
    for key, item in require_dict(value, ctx=ctx).items():
        match item:
            case str():
                out[key] = item
            case list():
                out[key] = _str_list(item, ctx=f"{ctx}.{key}")
            case _:
                raise ContractError(
                    f"{ctx}.{key}: frontmatter value must be a string or list of strings"
                )
    return out


# --- user_answers validators (model-authored -> Literal fields) --------------------------


def require_answer(answers: Mapping[str, JsonValue], key: str, *, ctx: str) -> str:
    """a required non-empty string answer."""
    return require_str_field(answers, key, ctx=ctx)


_PROVIDERS: tuple[Provider, ...] = ("anthropic", "openai", "gemini", "azure", "bedrock", "vertex")
_OPERATORS: tuple[ConditionOperator, ...] = (
    "equal", "notEqual", "contains", "notContains", "startsWith", "endsWith", "regex",
)
_ACTIONS: tuple[PolicyAction, ...] = (
    "allow_when_context_is_untrusted", "block_when_context_is_untrusted",
    "block_always", "require_approval",
)
_SCOPES: tuple[Scope, ...] = ("personal", "team", "org")
_SERVER_TYPES: tuple[ServerType, ...] = ("local", "remote")
_INTENTS: tuple[HookIntent, ...] = ("guard", "passive")
_HOOK_SOURCES: tuple[HookSource, ...] = ("bundled", "inline", "unresolved")
_TARGET_KINDS: tuple[TargetKind, ...] = (
    "agent", "skill", "mcp_catalog", "mcp_install", "llm_key", "tool_policy", "hook",
)
_PLAN_ACTIONS: tuple[Literal["migrate", "skip", "manual"], ...] = ("migrate", "skip", "manual")
_ENCODINGS: tuple[Literal["utf8", "base64"], ...] = ("utf8", "base64")

_LiteralT = TypeVar("_LiteralT", bound=str)


def _require_literal(
    value: object, allowed: tuple[_LiteralT, ...], *, what: str, ctx: str
) -> _LiteralT:
    """the one mechanism behind enum-shaped fields crossing a trust boundary."""
    if value not in allowed:
        raise ContractError(f"{ctx}: {what} {value!r} must be one of {'|'.join(allowed)}")
    return cast("_LiteralT", value)


def require_provider(answers: Mapping[str, JsonValue], *, ctx: str) -> Provider:
    value = require_str_field(answers, "provider", ctx=ctx)
    return _require_literal(value, _PROVIDERS, what="provider", ctx=ctx)


def require_operator(answers: Mapping[str, JsonValue], *, ctx: str) -> ConditionOperator:
    value = require_str_field(answers, "operator", ctx=ctx)
    return _require_literal(value, _OPERATORS, what="operator", ctx=ctx)


def optional_action(answers: Mapping[str, JsonValue], *, ctx: str) -> PolicyAction:
    """policy action defaults to block_always when the answer omits it."""
    value = answers.get("action")
    if value is None:
        return "block_always"
    return _require_literal(value, _ACTIONS, what="action", ctx=ctx)


# --- hook validators (shared by discover PEP-723 extraction + apply build) -----------------


def archestra_file_name(value: str, *, ctx: str) -> str:
    """a plain hook file name ending in .py or .sh (mirrors HookFileNameSchema)."""
    if len(value) > HOOK_FILE_NAME_MAX or HOOK_FILE_NAME_RE.match(value) is None:
        raise ContractError(
            f"{ctx}: hook file name {value!r} must match {HOOK_FILE_NAME_RE.pattern} "
            f"and be at most {HOOK_FILE_NAME_MAX} chars"
        )
    return value


def validate_requirements(value: object, *, ctx: str) -> list[str]:
    """validate a list of pip requirements (mirrors HookRequirementsSchema): each is trimmed,
    non-empty, single-line, <= 200 chars; at most 20 entries. trimmed values are returned."""
    raw = _str_list(value, ctx=ctx)
    if len(raw) > HOOK_REQUIREMENTS_MAX:
        raise ContractError(f"{ctx}: at most {HOOK_REQUIREMENTS_MAX} requirements, got {len(raw)}")
    out: list[str] = []
    for i, item in enumerate(raw):
        req = item.strip()
        if not req:
            raise ContractError(f"{ctx}[{i}]: requirement must be a non-empty string")
        if len(req) > HOOK_REQUIREMENT_MAX_LEN:
            raise ContractError(f"{ctx}[{i}]: requirement exceeds {HOOK_REQUIREMENT_MAX_LEN} chars")
        if any(c in req for c in "\r\n\0"):
            raise ContractError(f"{ctx}[{i}]: requirement must be a single line")
        out.append(req)
    return out


def require_requirements(answers: Mapping[str, JsonValue], *, ctx: str) -> list[str] | None:
    """user-supplied requirements override, or None when the answer omits the key."""
    raw = answers.get("requirements")
    if raw is None:
        return None
    return validate_requirements(raw, ctx=f"{ctx}.requirements")


def optional_agent_id(answers: Mapping[str, JsonValue], *, ctx: str) -> str | None:
    """a hook may pin an explicit agent id (UUID); absent -> apply attaches the primary agent."""
    raw = answers.get("agentId")
    if raw is None:
        return None
    if not isinstance(raw, str) or _UUID_RE.match(raw) is None:
        raise ContractError(f"{ctx}.agentId: must be a UUID string, got {raw!r}")
    return raw


def optional_file_name(answers: Mapping[str, JsonValue], *, ctx: str) -> str | None:
    """an explicit hook file name override (kept distinct from name_override, a display name)."""
    raw = answers.get("fileName")
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ContractError(f"{ctx}.fileName: must be a string, got {raw!r}")
    return archestra_file_name(raw, ctx=f"{ctx}.fileName")


def require_hook_content(text: str, *, ctx: str) -> str:
    """hook script body must be non-empty and within the backend's content cap."""
    if not 1 <= len(text) <= HOOK_CONTENT_MAX:
        raise ContractError(
            f"{ctx}: hook content length {len(text)} must be between 1 and {HOOK_CONTENT_MAX}"
        )
    return text


# --- parsing external JSON into typed objects --------------------------------------------


def parse_bundled_file(value: object, *, ctx: str) -> BundledFile:
    obj = require_dict(value, ctx=ctx)
    return BundledFile(
        path=require_str_field(obj, "path", ctx=ctx),
        content=require_str_field(obj, "content", ctx=ctx),
        encoding=_require_literal(
            require_str_field(obj, "encoding", ctx=ctx), _ENCODINGS, what="encoding", ctx=ctx
        ),
    )


def parse_item(value: object, *, ctx: str) -> Item:
    obj = require_dict(value, ctx=ctx)
    kind = require_str_field(obj, "kind", ctx=ctx)
    item_id = require_str_field(obj, "id", ctx=ctx)
    name = require_str_field(obj, "name", ctx=ctx)
    path = require_str_field(obj, "path", ctx=ctx)
    summary = _opt_str(obj, "summary", ctx=ctx) or ""
    files = [
        parse_bundled_file(f, ctx=f"{ctx}.files[{i}]")
        for i, f in enumerate(require_list(obj.get("files", []), ctx=f"{ctx}.files"))
    ]
    refs = _str_list(obj.get("redacted_refs", []), ctx=f"{ctx}.redacted_refs")
    data = require_dict(obj.get("data", {}), ctx=f"{ctx}.data")
    dctx = f"{ctx}.data"

    # the base fields are identical across kinds; only kind + data differ. construction is
    # explicit per branch (not **kwargs) so each item is fully type-checked.
    match kind:
        case "claude_md":
            return ClaudeMdItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=ClaudeMdData(
                    body=require_str_field(data, "body", ctx=dctx),
                    frontmatter=_frontmatter(data.get("frontmatter", {}), ctx=f"{dctx}.frontmatter"),
                ),
            )
        case "subagent":
            return SubagentItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=SubagentData(
                    body=require_str_field(data, "body", ctx=dctx),
                    description=_opt_str(data, "description", ctx=dctx),
                    tools=_parse_tools(data.get("tools"), ctx=f"{dctx}.tools"),
                ),
            )
        case "skill":
            return SkillItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=SkillData(
                    content=require_str_field(data, "content", ctx=dctx),
                    frontmatter=_frontmatter(data.get("frontmatter", {}), ctx=f"{dctx}.frontmatter"),
                ),
            )
        case "command":
            return CommandItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=CommandData(
                    body=require_str_field(data, "body", ctx=dctx),
                    frontmatter=_frontmatter(data.get("frontmatter", {}), ctx=f"{dctx}.frontmatter"),
                ),
            )
        case "local_tool":
            return LocalToolItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=LocalToolData(entrypoint=require_str_field(data, "entrypoint", ctx=dctx)),
            )
        case "mcp_server":
            return McpServerItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=McpServerData(
                    transport=_require_literal(
                        data.get("transport"), _SERVER_TYPES, what="transport", ctx=dctx
                    ),
                    command=_opt_str(data, "command", ctx=dctx),
                    args=_str_list(data.get("args", []), ctx=f"{dctx}.args"),
                    env=_str_map(data.get("env", {}), ctx=f"{dctx}.env"),
                    url=_opt_str(data, "url", ctx=dctx),
                ),
            )
        case "hook":
            return HookItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=HookData(
                    event=require_str_field(data, "event", ctx=dctx),
                    command=require_str_field(data, "command", ctx=dctx),
                    intent=_require_literal(data.get("intent"), _INTENTS, what="intent", ctx=dctx),
                    source=_require_literal(data.get("source"), _HOOK_SOURCES, what="source", ctx=dctx),
                    matcher=_opt_str(data, "matcher", ctx=dctx),
                    file_name=_opt_str(data, "file_name", ctx=dctx),
                    script_path=_opt_str(data, "script_path", ctx=dctx),
                    requirements=_str_list(data.get("requirements", []), ctx=f"{dctx}.requirements"),
                ),
            )
        case "openclaw":
            return OpenclawItem(
                id=item_id, name=name, path=path, summary=summary, files=files, redacted_refs=refs,
                data=OpenclawData(config=require_dict(data.get("config", {}), ctx=f"{dctx}.config")),
            )
        case _:
            raise ContractError(f"{ctx}: unknown item kind {kind!r}")


def _parse_tools(value: object, *, ctx: str) -> str | list[str] | None:
    match value:
        case None:
            return None
        case str():
            return value
        case list():
            return _str_list(value, ctx=ctx)
        case _:
            raise ContractError(f"{ctx}: tools must be a string, list of strings, or absent")


def parse_inventory(value: object, *, ctx: str = "inventory") -> Inventory:
    obj = require_dict(value, ctx=ctx)
    items = [
        parse_item(it, ctx=f"{ctx}.items[{i}]")
        for i, it in enumerate(require_list(obj.get("items", []), ctx=f"{ctx}.items"))
    ]
    return Inventory(
        source_root=require_str_field(obj, "source_root", ctx=ctx),
        schema_version=_require_int(obj.get("schema_version", SCHEMA_VERSION), ctx=f"{ctx}.schema_version"),
        items=items,
        unknowns=_str_list(obj.get("unknowns", []), ctx=f"{ctx}.unknowns"),
        warnings=_str_list(obj.get("warnings", []), ctx=f"{ctx}.warnings"),
    )


def parse_decision(value: object, *, ctx: str) -> Decision:
    obj = require_dict(value, ctx=ctx)
    return Decision(
        source_id=require_str_field(obj, "source_id", ctx=ctx),
        target_kind=_require_literal(
            obj.get("target_kind"), _TARGET_KINDS, what="target kind", ctx=f"{ctx}.target_kind"
        ),
        scope=_require_literal(obj.get("scope"), _SCOPES, what="scope", ctx=f"{ctx}.scope"),
        action=_require_literal(
            obj.get("action", "migrate"), _PLAN_ACTIONS, what="action", ctx=f"{ctx}.action"
        ),
        name_override=_opt_str(obj, "name_override", ctx=ctx),
        notes=_opt_str(obj, "notes", ctx=ctx),
        user_answers=require_dict(obj.get("user_answers", {}), ctx=f"{ctx}.user_answers"),
    )


def parse_plan(value: object, *, ctx: str = "plan") -> MigrationPlan:
    obj = require_dict(value, ctx=ctx)
    decisions = [
        parse_decision(d, ctx=f"{ctx}.decisions[{i}]")
        for i, d in enumerate(require_list(obj.get("decisions", []), ctx=f"{ctx}.decisions"))
    ]
    return MigrationPlan(
        schema_version=_require_int(obj.get("schema_version", SCHEMA_VERSION), ctx=f"{ctx}.schema_version"),
        default_scope=_require_literal(
            obj.get("default_scope"), _SCOPES, what="scope", ctx=f"{ctx}.default_scope"
        ),
        decisions=decisions,
    )


def _require_int(value: object, *, ctx: str) -> int:
    # bool is an int subclass; reject it explicitly so True can't masquerade as 1.
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractError(f"{ctx}: expected an integer, got {value!r}")
    return value


# --- serialization -----------------------------------------------------------------------


def to_jsonable(obj: object) -> JsonValue:
    """recursively convert dataclasses/lists/dicts to plain JSON-able values."""
    if is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: to_jsonable(getattr(obj, f.name)) for f in fields(obj)}
    match obj:
        case bool() | int() | float() | str() | None:
            return obj
        case list():
            return [to_jsonable(v) for v in obj]
        case dict():
            return {str(k): to_jsonable(v) for k, v in obj.items()}
        case _:
            raise TypeError(f"cannot serialize {type(obj).__name__} to JSON")
