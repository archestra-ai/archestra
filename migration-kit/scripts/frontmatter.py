# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""a zero-dependency parser for the markdown frontmatter Claude Code uses.

this replaces the only production use of PyYAML. it deliberately supports a *documented
subset* of YAML and SURFACES anything outside it (via ``ParsedDoc.unparsed_lines``) rather
than guessing -- a wrong guess would silently corrupt a migrated name/description/tool list.

supported inside the ``---`` fence:
  * ``key: value`` scalars (unquoted, 'single-quoted', or "double-quoted")
  * inline flow lists: ``key: [a, b, c]``
  * block lists:       ``key:`` then ``  - a`` / ``  - b`` lines

explicitly NOT supported (each such line is surfaced, never interpreted):
  * block scalars ``|`` / ``>``                  (e.g. ``description: |``)
  * nested mappings (``key:`` followed by ``child: ...`` instead of ``- ...``)
  * anchors/aliases ``&`` / ``*`` and tags ``!``
  * unquoted ``#`` inline comments and trailing content after a quoted scalar

emit_frontmatter is the inverse used by apply.py; it quotes via json.dumps (a JSON string is
a valid YAML double-quoted scalar), so emit -> parse round-trips and the output is valid YAML.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from contracts import FrontMatter, FrontMatterValue

_FENCE = "---"
_KEY_LINE = re.compile(r"^([A-Za-z0-9_.-]+):(.*)$")


@dataclass(frozen=True)
class ParsedDoc:
    frontmatter: FrontMatter = field(default_factory=dict)
    body: str = ""
    unparsed_lines: list[str] = field(default_factory=list)


def parse_frontmatter(text: str) -> ParsedDoc:
    """split a markdown doc into frontmatter + body, surfacing unparsable frontmatter lines."""
    # normalize CRLF (the editors that touch these files) so '\r' neither breaks exact fence
    # matching nor lingers in the body. bare-CR line endings are not handled (not seen in practice).
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")
    # the opening fence must be a line that is exactly '---' (not '--- text', '----', or '  ---').
    if not lines or lines[0] != _FENCE:
        return ParsedDoc(body=text)
    # find the closing fence (first line that is exactly '---' after the opening one).
    close = next((i for i in range(1, len(lines)) if lines[i] == _FENCE), None)
    if close is None:
        return ParsedDoc(body=text)

    fm, unparsed = _parse_block(lines[1:close])
    body = "\n".join(lines[close + 1:]).lstrip("\n")
    return ParsedDoc(frontmatter=fm, body=body, unparsed_lines=unparsed)


def _parse_block(lines: list[str]) -> tuple[FrontMatter, list[str]]:
    fm: FrontMatter = {}
    unparsed: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        # an indented line outside a block-list context is a nested structure we don't support.
        if line[0].isspace():
            unparsed.append(line)
            i += 1
            continue
        m = _KEY_LINE.match(line)
        if m is None:
            unparsed.append(line)
            i += 1
            continue

        key, rest = m.group(1), m.group(2).strip()
        if rest == "":
            # could be a block list (following '- ' lines) or an unsupported nested/empty value.
            items, consumed = _take_block_list(lines, i + 1)
            if items is None:
                unparsed.append(line)
                i += 1
            else:
                _assign(fm, unparsed, key, items, line)
                i = consumed
            continue

        value = _parse_value(rest)
        if value is None:
            unparsed.append(line)
        else:
            _assign(fm, unparsed, key, value, line)
        i += 1
    return fm, unparsed


def _assign(fm: FrontMatter, unparsed: list[str], key: str, value: FrontMatterValue, line: str) -> None:
    # a duplicate key is ambiguous (YAML rejects it); surface it rather than silently overwriting.
    if key in fm:
        unparsed.append(line)
    else:
        fm[key] = value


def _take_block_list(lines: list[str], start: int) -> tuple[list[str] | None, int]:
    """collect consecutive '- item' lines starting at `start`. returns (items, next_index);
    items is None when no list item follows (so the empty-value key is unsupported)."""
    items: list[str] = []
    i = start
    n = len(lines)
    while i < n:
        stripped = lines[i].strip()
        if not stripped:
            break
        if not (stripped == "-" or stripped.startswith("- ")):
            break
        scalar = _parse_scalar(stripped[1:].strip())
        if scalar is None:
            return None, i  # an unsupported item -> surface the whole key
        items.append(scalar)
        i += 1
    return (items, i) if items else (None, start)


def _parse_value(rest: str) -> FrontMatterValue | None:
    """parse a scalar or an inline flow list; None when unsupported."""
    if rest.startswith("["):
        return _parse_flow_list(rest)
    return _parse_scalar(rest)


def _parse_flow_list(rest: str) -> list[str] | None:
    if not rest.endswith("]"):
        return None
    inner = rest[1:-1]
    if "[" in inner or "]" in inner or "{" in inner or "}" in inner:
        return None  # nested flow collections are unsupported
    if not inner.strip():
        return []
    out: list[str] = []
    for part in inner.split(","):
        token = part.strip()
        # an unquoted `key: value` element is a mapping in flow context -> unsupported, surface.
        if token[:1] not in ("'", '"') and re.search(r":(\s|$)", token):
            return None
        scalar = _parse_scalar(token)
        if scalar is None:
            return None
        out.append(scalar)
    return out


def _parse_scalar(token: str) -> str | None:
    """parse one scalar; None when unsupported (block scalar, anchor/tag, comment, etc.)."""
    if token == "":
        return None
    head = token[0]
    # leading YAML indicators: block scalars, anchors/aliases, tags, and a comment/null '#'.
    if head in "|>&*!#":
        return None
    if head == '"':
        # a JSON string is a valid YAML double-quoted scalar and the exact inverse of emit.
        try:
            decoded = json.loads(token)
        except json.JSONDecodeError:
            return None
        return decoded if isinstance(decoded, str) else None
    if head == "'":
        return _parse_single_quoted(token)
    # bare scalar: reject an unquoted inline comment rather than swallow it.
    if "#" in token and re.search(r"\s#", token):
        return None
    return token


def _parse_single_quoted(token: str) -> str | None:
    # YAML single-quoted scalars escape a quote by doubling it ('').
    if len(token) < 2:
        return None
    i = 1
    out: list[str] = []
    n = len(token)
    while i < n:
        ch = token[i]
        if ch == "'":
            if i + 1 < n and token[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            # closing quote: anything after it (e.g. a trailing comment) is unsupported.
            return "".join(out) if i == n - 1 else None
        out.append(ch)
        i += 1
    return None  # unterminated


def emit_frontmatter(name: str, description: str) -> str:
    """emit a minimal, valid-YAML frontmatter block. json.dumps quoting means names or
    descriptions with YAML-significant characters cannot break the block."""
    return f"---\nname: {json.dumps(name)}\ndescription: {json.dumps(description)}\n---\n"
