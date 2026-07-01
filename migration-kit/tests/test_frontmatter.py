"""tests for the zero-dependency frontmatter parser, with PyYAML as an oracle."""
import pytest
import yaml

from contracts import ContractError
from frontmatter import emit_frontmatter, parse_frontmatter, set_name


def test_no_fence_is_all_body() -> None:
    doc = parse_frontmatter("just a body, no frontmatter")
    assert doc.frontmatter == {}
    assert doc.body == "just a body, no frontmatter"
    assert doc.unparsed_lines == []


def test_scalars_and_body_preserved() -> None:
    doc = parse_frontmatter('---\nname: fact-checker\ndescription: Check facts.\n---\nthe body\n')
    assert doc.frontmatter == {"name": "fact-checker", "description": "Check facts."}
    assert doc.body == "the body\n"
    assert doc.unparsed_lines == []


def test_quoted_scalars() -> None:
    doc = parse_frontmatter('---\na: "quoted: value"\nb: \'single #hash\'\n---\nx')
    assert doc.frontmatter == {"a": "quoted: value", "b": "single #hash"}


def test_inline_flow_list() -> None:
    doc = parse_frontmatter('---\ntools: [Read, Bash, "Skill"]\n---\nx')
    assert doc.frontmatter == {"tools": ["Read", "Bash", "Skill"]}


def test_block_list() -> None:
    doc = parse_frontmatter("---\ntools:\n  - Read\n  - Bash\n---\nx")
    assert doc.frontmatter == {"tools": ["Read", "Bash"]}


def test_comma_scalar_is_not_a_list() -> None:
    # a bare comma-separated value stays a string (claude's `tools: Read, Bash` form).
    doc = parse_frontmatter("---\ntools: Read, Bash, Skill\n---\nx")
    assert doc.frontmatter == {"tools": "Read, Bash, Skill"}


# --- unsupported forms must be SURFACED, never silently mis-parsed --------------------------

UNSUPPORTED = {
    "block_scalar": "---\ndescription: |\n  multi\n  line\n---\nx",
    "folded_scalar": "---\ndescription: >\n  folded\n---\nx",
    "nested_map": "---\nparent:\n  child: y\n---\nx",
    "inline_comment": "---\nname: real # trailing comment\n---\nx",
    "leading_hash": "---\ncolor: #fff\n---\nx",
    "anchor": "---\nname: &anchor value\n---\nx",
}


def test_unsupported_forms_are_surfaced() -> None:
    for label, text in UNSUPPORTED.items():
        doc = parse_frontmatter(text)
        assert doc.unparsed_lines, f"{label} should have surfaced an unparsed line"
        # whatever we DID parse must agree with PyYAML (i.e. we never invented a value).
        oracle = yaml.safe_load(text.split("---", 2)[1]) or {}
        for key, value in doc.frontmatter.items():
            assert oracle.get(key) == value, f"{label}: mis-parsed {key!r}"


def test_non_exact_opening_fence_is_treated_as_body() -> None:
    # '--- text' (or '----') is not a frontmatter fence; the whole text is the body.
    text = "--- not a fence\nname: x\nmore body"
    doc = parse_frontmatter(text)
    assert doc.frontmatter == {}
    assert doc.body == text


def test_flow_list_with_mapping_is_surfaced() -> None:
    doc = parse_frontmatter("---\ntools: [a: b, c]\n---\nx")
    assert "tools" not in doc.frontmatter  # not guessed
    assert doc.unparsed_lines


def test_duplicate_key_is_surfaced_and_first_wins() -> None:
    doc = parse_frontmatter("---\nname: first\nname: second\n---\nx")
    assert doc.frontmatter["name"] == "first"
    assert any("second" in line for line in doc.unparsed_lines)


def test_emit_roundtrips_through_parser_and_pyyaml() -> None:
    hostile = 'evil: name "with" #chars'
    emitted = emit_frontmatter(hostile, "a description")
    # our own parser round-trips it...
    doc = parse_frontmatter(emitted + "body")
    assert doc.frontmatter["name"] == hostile
    # ...and it is genuinely valid YAML (independent oracle).
    assert yaml.safe_load(emitted.split("---", 2)[1])["name"] == hostile


def test_crlf_is_normalized_in_body() -> None:
    doc = parse_frontmatter("---\r\nname: x\r\n---\r\nline1\r\nline2\r\n")
    assert doc.frontmatter == {"name": "x"}
    assert "\r" not in doc.body
    assert doc.body == "line1\nline2\n"


def test_indented_fence_does_not_close_frontmatter() -> None:
    # an indented '  ---' is not a closing fence; the real '---' below it closes the block.
    doc = parse_frontmatter("---\nname: x\n  ---\ndescription: y\n---\nbody")
    assert doc.frontmatter.get("name") == "x"
    assert doc.frontmatter.get("description") == "y"
    assert doc.body == "body"
    assert any("---" in line for line in doc.unparsed_lines)  # the indented line is surfaced


# --- set_name: rename a skill's frontmatter name in place ----------------------------------


def test_set_name_noop_when_already_matching() -> None:
    # the verbatim-skill invariant: an unchanged name must not even requote the value.
    content = "---\nname: summarize-text\ndescription: d\n---\nbody\n"
    assert set_name(content, "summarize-text") == content


def test_set_name_rewrites_existing_name() -> None:
    content = "---\nname: old\ndescription: d\n---\nbody\n"
    out = set_name(content, "new-prefix-old")
    fm = yaml.safe_load(out.split("---", 2)[1])
    assert fm == {"name": "new-prefix-old", "description": "d"}
    assert parse_frontmatter(out).body == "body\n"  # body untouched


def test_set_name_preserves_other_lines_including_unsupported() -> None:
    # a nested map ships verbatim through the parser; renaming must not disturb it.
    content = "---\nname: old\ndescription: d\nmetadata:\n  patterns:\n    - a\n---\nbody\n"
    out = set_name(content, "renamed")
    assert "metadata:\n  patterns:\n    - a" in out
    assert yaml.safe_load(out.split("---", 2)[1])["name"] == "renamed"


def test_set_name_inserts_when_name_absent() -> None:
    content = "---\ndescription: d\n---\nbody\n"
    out = set_name(content, "added")
    fm = yaml.safe_load(out.split("---", 2)[1])
    assert fm == {"name": "added", "description": "d"}


def test_set_name_prepends_fence_when_no_frontmatter() -> None:
    out = set_name("just a body\n", "added")
    assert yaml.safe_load(out.split("---", 2)[1]) == {"name": "added"}
    assert out.endswith("just a body\n")


def test_set_name_quotes_yaml_hostile_names() -> None:
    out = set_name("---\nname: old\n---\nb", 'has: colon "and" quotes')
    assert yaml.safe_load(out.split("---", 2)[1])["name"] == 'has: colon "and" quotes'


@pytest.mark.parametrize("value", ["|", ">", "&anchor val", "*alias"])
def test_set_name_refuses_unrewritable_value_forms(value: str) -> None:
    # never corrupt a block scalar / anchor by editing only its first line.
    with pytest.raises(ContractError, match="cannot safely rewrite"):
        set_name(f"---\nname: {value}\ndescription: d\n---\nb", "renamed")


def test_set_name_noop_preserves_crlf() -> None:
    content = "---\r\nname: x\r\ndescription: d\r\n---\r\nbody\r\n"
    assert set_name(content, "x") == content  # no-op keeps the original line endings byte-for-byte
