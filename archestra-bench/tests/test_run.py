"""Pure-helper tests for the env-configurable tool surface and runtime placeholder expansion.

These exercise run.py's decision logic without a client: the `basic` env (empty allow-list) must
still strip and reject the mutating skill tools, an allow-list must let exactly the named extras
survive, and the runtime expander must substitute only `{{cell}}`/`{{agent_id}}`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path

import pytest

from archestra_client import ArchestraApiError
from envs import EnvConfig
from eval_client import ChatRunResult, ChatStreamRecord
from results import Outcome, RunResult, aggregate, build_report
from run import (
    Lane,
    ProgressReporter,
    _build_run_plan,
    _cell_token,
    _drive_stage,
    _expand_runtime,
    _lane_unit,
    _load_lanes,
    _resolve_workers,
    _RunArtifacts,
    _RunCtx,
    _StreamCoalescer,
    _surface_violations,
    _tools_to_strip,
)
from tasks import Stage, Task, Verifier

_BASE = frozenset(
    {
        "archestra__artifact_write",
        "archestra__todo_write",
        "archestra__run_command",
        "archestra__upload_file",
        "archestra__download_file",
        "archestra__list_skills",
        "archestra__load_skill",
    }
)
_CREATE = "archestra__create_skill"
_UPDATE = "archestra__update_skill"
_SUBMIT = "benchmark__submit_result"


def test_basic_env_strips_both_mutating_tools() -> None:
    assert _tools_to_strip(frozenset()) == {_CREATE, _UPDATE}


def test_allow_list_keeps_only_named_mutating_tool() -> None:
    assert _tools_to_strip(frozenset({_CREATE})) == {_UPDATE}


def test_basic_env_rejects_a_leaked_mutating_tool() -> None:
    present = set(_BASE) | {_SUBMIT, _CREATE}  # create_skill must NOT survive with an empty allow-list
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset(), submit_tool=_SUBMIT)
    assert any("mutate the skill library" in v for v in violations)


def test_allowed_mutating_tool_is_not_a_violation() -> None:
    present = set(_BASE) | {_SUBMIT, _CREATE}
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset({_CREATE}), submit_tool=_SUBMIT)
    assert violations == []


def test_missing_required_tool_is_a_violation() -> None:
    present = (set(_BASE) | {_SUBMIT}) - {"archestra__run_command"}
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset(), submit_tool=_SUBMIT)
    assert any("missing required tools" in v for v in violations)


def test_missing_submit_tool_is_a_violation() -> None:
    violations = _surface_violations(set(_BASE), required=set(_BASE), allowed=frozenset(), submit_tool=_SUBMIT)
    assert any("benchmark tool" in v for v in violations)


def test_missing_allowed_extra_is_a_violation() -> None:
    present = set(_BASE) | {_SUBMIT}  # create_skill allowed but not actually assigned
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset({_CREATE}), submit_tool=_SUBMIT)
    assert any("missing required tools" in v for v in violations)


def test_expand_runtime_substitutes_known_placeholders_only() -> None:
    out = _expand_runtime("{{cell}} {{agent_id}} {{file:keep.csv}}", {"cell": "c1", "agent_id": "ag-9"})
    assert out == "c1 ag-9 {{file:keep.csv}}"


def test_cell_token_is_skill_name_safe() -> None:
    token = _cell_token("archestra-api/author-skill/claude-opus-4-8[1m]", "claude-opus-4-8[1m]")
    assert re.fullmatch(r"[a-z0-9-]+", token)
    assert token.startswith("claude-opus-4-8-1m-")


def test_cell_token_unique_per_cell() -> None:
    # same model in different tasks -> different token (resources don't collide on one backend)
    assert _cell_token("e/t1/m", "m") != _cell_token("e/t2/m", "m")
    # models that slug identically still differ, via the hash of the full cell key
    assert _cell_token("e/t/a.b", "a.b") != _cell_token("e/t/a-b", "a-b")


def test_resolve_workers_default_is_one_per_lane_capped() -> None:
    assert _resolve_workers(None, 3) == 3
    assert _resolve_workers(None, 10) == 4  # capped at _MAX_WORKERS_CAP
    assert _resolve_workers(None, 0) == 1  # never zero workers


def test_resolve_workers_honors_explicit_value() -> None:
    assert _resolve_workers(1, 4) == 1
    assert _resolve_workers(8, 2) == 8


def test_resolve_workers_rejects_below_one() -> None:
    with pytest.raises(SystemExit):
        _resolve_workers(0, 4)


# === lanes ===

_LANES_TOML = """
[[lane]]
name = "sonnet"
provider = "anthropic"
model = "claude-sonnet-4-6"

[[lane]]
name = "kimi"
provider = "anthropic"
model = "kimi-for-coding"
base_url = "https://api.kimi.com/coding/"
api_key_env = "KIMI_API_KEY"

[[lane]]
name = "or-free"
provider = "openrouter"
model = "deepseek/deepseek-chat-v3.1:free"
"""


def _lanes_file(tmp_path: Path, body: str = _LANES_TOML) -> Path:
    path = tmp_path / "lanes.toml"
    path.write_text(body, encoding="utf-8")
    return path


def test_load_lanes_all_when_unselected(tmp_path: Path) -> None:
    lanes = _load_lanes(_lanes_file(tmp_path), None)
    assert [lane.name for lane in lanes] == ["sonnet", "kimi", "or-free"]


def test_load_lanes_selects_subset_in_request_order(tmp_path: Path) -> None:
    lanes = _load_lanes(_lanes_file(tmp_path), "or-free,sonnet")
    assert [lane.name for lane in lanes] == ["or-free", "sonnet"]


def test_load_lanes_carries_base_url_and_key_env(tmp_path: Path) -> None:
    (kimi,) = _load_lanes(_lanes_file(tmp_path), "kimi")
    assert kimi.base_url == "https://api.kimi.com/coding/"
    assert kimi.key_env == "KIMI_API_KEY"


def test_load_lanes_key_env_defaults_to_provider(tmp_path: Path) -> None:
    (sonnet,) = _load_lanes(_lanes_file(tmp_path), "sonnet")
    assert sonnet.key_env == "ANTHROPIC_API_KEY"


def test_load_lanes_model_may_contain_colon(tmp_path: Path) -> None:
    # OpenRouter free models look like `vendor/model:free` -- the model keeps its own colon.
    (lane,) = _load_lanes(_lanes_file(tmp_path), "or-free")
    assert lane.model == "deepseek/deepseek-chat-v3.1:free"


def test_load_lanes_rejects_unknown_selection(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="unknown lane"):
        _load_lanes(_lanes_file(tmp_path), "nope")


def test_load_lanes_rejects_unknown_provider(tmp_path: Path) -> None:
    body = '[[lane]]\nname = "x"\nprovider = "acme"\nmodel = "m"\n'
    with pytest.raises(SystemExit, match="unsupported provider"):
        _load_lanes(_lanes_file(tmp_path, body), None)


def test_load_lanes_rejects_duplicate_name(tmp_path: Path) -> None:
    body = (
        '[[lane]]\nname = "x"\nprovider = "anthropic"\nmodel = "m"\n'
        '[[lane]]\nname = "x"\nprovider = "gemini"\nmodel = "n"\n'
    )
    with pytest.raises(SystemExit, match="duplicate lane name"):
        _load_lanes(_lanes_file(tmp_path, body), None)


def test_load_lanes_rejects_non_slug_name(tmp_path: Path) -> None:
    body = '[[lane]]\nname = "Bad Name"\nprovider = "anthropic"\nmodel = "m"\n'
    with pytest.raises(SystemExit, match="must be a slug"):
        _load_lanes(_lanes_file(tmp_path, body), None)


def test_load_lanes_rejects_empty_catalog(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="no .* defined"):
        _load_lanes(_lanes_file(tmp_path, "\n"), None)


# === run plan ===


def _env(env_id: str, *, share_backend: bool) -> EnvConfig:
    return EnvConfig(
        id=env_id, name=env_id, agent_name=f"{env_id}-agent", agent_system_prompt="p",
        skills=(), mcps=(), tasks=(), share_backend=share_backend,
    )


def test_build_run_plan_fans_lanes_over_envs_and_carries_flag() -> None:
    shared, isolated = _env("basic", share_backend=True), _env("api", share_backend=False)
    lanes = [Lane("l1", "anthropic", "m1"), Lane("l2", "gemini", "m2")]
    plan = _build_run_plan([(shared, []), (isolated, [])], lanes)
    assert [p.env.id for p in plan] == ["basic", "api"]
    assert all(tuple(p.lanes) == tuple(lanes) for p in plan)
    assert [p.share_backend for p in plan] == [True, False]


# === report determinism ===


def _result(lane: str, provider: str, model: str) -> RunResult:
    return RunResult(
        env_id="e", task_id="t", lane=lane, provider=provider, model=model, outcome=Outcome.PASSED,
        finish_reason=None, tool_call_count=0, turn_count=0, total_tokens=None, agent_error=None,
        stage_count=1, format_attempts=0, artifact_dir=None,
    )


def test_build_report_keys_on_lane_so_same_model_two_gateways_coexist() -> None:
    # out-of-order input -> sorted by (env, task, lane); two lanes on one provider+model don't collide.
    rows = build_report([_result("kimi", "anthropic", "m"), _result("zai", "anthropic", "m")])
    assert [r.lane for r in rows] == ["kimi", "zai"]


def test_build_report_rejects_true_duplicate_cell() -> None:
    with pytest.raises(ValueError, match="duplicate result"):
        build_report([_result("kimi", "anthropic", "m"), _result("kimi", "anthropic", "m")])


def test_aggregate_groups_by_lane_not_provider() -> None:
    # two lanes share a provider -> they must roll up as distinct lane rows, not one provider row.
    rows = [
        _result("kimi", "anthropic", "m"),
        _result("glm", "anthropic", "m"),
        _result("minimax", "openrouter", "n"),
    ]
    agg = aggregate(rows)
    assert [g.key for g in agg.per_lane] == ["glm", "kimi", "minimax"]
    assert all(g.total == 1 for g in agg.per_lane)
    assert "per_lane" in agg.to_json() and "per_provider" not in agg.to_json()


# === lane slug ===


def test_lane_slug_is_name_safe() -> None:
    # the lane name is the stable identity for its agent / benchmark MCP / artifact dir.
    assert Lane("or-free", "openrouter", "x/y:free").slug == "or-free"
    assert re.fullmatch(r"[A-Za-z0-9._-]+", Lane("kimi", "anthropic", "m").slug)


# === lane failure isolation ===


def _task(task_id: str) -> Task:
    return Task(id=task_id, dir=Path("."), stages=(), result_schema={}, verifier=Verifier())


def _env_cfg() -> EnvConfig:
    return EnvConfig(
        id="e", name="e", agent_name="e-agent", agent_system_prompt="p", skills=(), mcps=(), tasks=(),
    )


def test_lane_unit_turns_an_exception_into_infra_results_for_all_tasks(tmp_path: Path) -> None:
    ctx = _RunCtx(root_run_dir=tmp_path, run_id="r", api_keys={})
    tasks = (_task("t1"), _task("t2"))
    lane = Lane("g", "gemini", "g")

    def boom(_out: list[RunResult]) -> None:
        raise RuntimeError("backend exited early")

    results = _lane_unit(_env_cfg(), tasks, lane, ctx, ProgressReporter(len(tasks)), boom)()  # must NOT raise
    assert [r.task_id for r in results] == ["t1", "t2"]
    assert all(r.outcome is Outcome.AGENT_ERROR and (r.agent_error or "").startswith("infra:") for r in results)
    # a per-cell record is persisted for every task, so no cell silently vanishes from the run dir
    for task in tasks:
        cell = tmp_path / "e" / f"{task.id}__{lane.slug}"
        assert (cell / "run.json").is_file() and (cell / "trajectory.jsonl").is_file()


def test_lane_unit_isolates_systemexit_too(tmp_path: Path) -> None:
    # ensure_provider_and_models raises SystemExit for a model that never syncs; one bad lane must
    # not abort the whole sweep -- it becomes infra results like any other lane failure.
    ctx = _RunCtx(root_run_dir=tmp_path, run_id="r", api_keys={})

    def never_syncs(_out: list[RunResult]) -> None:
        raise SystemExit("models never synced")

    results = _lane_unit(_env_cfg(), (_task("t1"),), Lane("g", "gemini", "g"), ctx, ProgressReporter(1), never_syncs)()
    assert [r.outcome for r in results] == [Outcome.AGENT_ERROR]


def test_lane_unit_preserves_partial_results_and_fills_only_missing(tmp_path: Path) -> None:
    ctx = _RunCtx(root_run_dir=tmp_path, run_id="r", api_keys={})
    tasks = (_task("t1"), _task("t2"))
    done = RunResult(
        env_id="e", task_id="t1", lane="g", provider="gemini", model="g", outcome=Outcome.PASSED,
        finish_reason="stop", tool_call_count=0, turn_count=0, total_tokens=None, agent_error=None,
        stage_count=0, format_attempts=0, artifact_dir=None,
    )

    def half(out: list[RunResult]) -> None:
        out.append(done)  # t1 already graded
        raise RuntimeError("crashed before t2")

    results = _lane_unit(_env_cfg(), tasks, Lane("g", "gemini", "g"), ctx, ProgressReporter(len(tasks)), half)()
    assert results[0] is done  # the real t1 result is kept, not clobbered
    assert results[1].task_id == "t2" and results[1].outcome is Outcome.AGENT_ERROR


# === trajectory coalescing ===


def _ev(**event: object) -> ChatStreamRecord:
    return ChatStreamRecord(kind="event", event=event)


def _coalesce(records: list[ChatStreamRecord], cell: Path, *, flush: bool = True) -> list[dict[str, object]]:
    coalescer = _StreamCoalescer(_RunArtifacts(cell))
    for record in records:
        coalescer.feed(record)
    if flush:
        coalescer.flush()
    path = cell / "trajectory.jsonl"
    if not path.exists():  # nothing written -> all records were dropped as noise
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_coalesce_folds_text_deltas_into_one_assistant_text(tmp_path: Path) -> None:
    out = _coalesce(
        [
            _ev(type="text-start", id="0"),
            _ev(type="text-delta", id="0", delta="Hel"),
            _ev(type="text-delta", id="0", delta="lo "),
            _ev(type="text-delta", id="0", delta="world"),
            _ev(type="text-end", id="0"),
        ],
        tmp_path / "cell",
    )
    assert [r["kind"] for r in out] == ["assistant_text"]
    assert out[0]["text"] == "Hello world" and out[0]["id"] == "0"


def test_coalesce_tolerates_text_delta_without_start(tmp_path: Path) -> None:
    out = _coalesce([_ev(type="text-delta", id="0", delta="hi"), _ev(type="text-end", id="0")], tmp_path / "cell")
    assert [r["kind"] for r in out] == ["assistant_text"]
    assert out[0]["text"] == "hi"


def test_coalesce_tool_input_takes_full_input_and_strips_provider_metadata(tmp_path: Path) -> None:
    out = _coalesce(
        [
            _ev(type="tool-input-start", toolCallId="t1", toolName="archestra__run_command"),
            _ev(type="tool-input-delta", toolCallId="t1", inputTextDelta='{"command":'),
            _ev(type="tool-input-delta", toolCallId="t1", inputTextDelta='"ls"}'),
            _ev(
                type="tool-input-available",
                toolCallId="t1",
                toolName="archestra__run_command",
                input={"command": "ls"},
                providerMetadata={"google": {"thoughtSignature": "BIG"}},
            ),
        ],
        tmp_path / "cell",
    )
    assert [r["kind"] for r in out] == ["tool_call"]  # the deltas fold away; the full input survives
    call = out[0]
    assert call["tool_call_id"] == "t1" and call["tool_name"] == "archestra__run_command"
    assert call["input"] == {"command": "ls"} and "providerMetadata" not in call


def test_coalesce_normalizes_tool_call_event_like_the_grader(tmp_path: Path) -> None:
    # _apply_chat_event treats `tool-call` as a tool invocation too; the trajectory must match.
    out = _coalesce([_ev(type="tool-call", toolName="x", input={"a": 1})], tmp_path / "cell")
    assert [r["kind"] for r in out] == ["tool_call"]
    assert out[0]["tool_name"] == "x" and out[0]["input"] == {"a": 1} and out[0]["tool_call_id"] is None


def test_coalesce_passes_malformed_tool_call_through_instead_of_fabricating(tmp_path: Path) -> None:
    # a tool event with no string toolName is one the grader skips; record it verbatim, not as a tool_call.
    out = _coalesce([_ev(type="tool-input-available", toolCallId="t1", input={"a": 1})], tmp_path / "cell")
    assert [r["kind"] for r in out] == ["chat_stream"] and out[0]["event"]["toolCallId"] == "t1"


def test_coalesce_flushes_interrupted_tool_input_as_partial(tmp_path: Path) -> None:
    # stream drops after tool-input-start/-delta, before tool-input-available: keep the attempt, not silence.
    out = _coalesce(
        [
            _ev(type="tool-input-start", toolCallId="t1", toolName="archestra__run_command"),
            _ev(type="tool-input-delta", toolCallId="t1", inputTextDelta='{"command":'),
            _ev(type="tool-input-delta", toolCallId="t1", inputTextDelta='"ls'),
        ],
        tmp_path / "cell",
    )
    assert [r["kind"] for r in out] == ["tool_call_partial"]
    assert out[0]["tool_call_id"] == "t1" and out[0]["tool_name"] == "archestra__run_command"
    assert out[0]["partial_input"] == '{"command":"ls'


def test_coalesce_completed_tool_input_leaves_no_partial(tmp_path: Path) -> None:
    out = _coalesce(
        [
            _ev(type="tool-input-start", toolCallId="t1", toolName="x"),
            _ev(type="tool-input-delta", toolCallId="t1", inputTextDelta='{"a":1}'),
            _ev(type="tool-input-available", toolCallId="t1", toolName="x", input={"a": 1}),
        ],
        tmp_path / "cell",
    )
    assert [r["kind"] for r in out] == ["tool_call"]  # the partial buffer was superseded; nothing left to flush


def test_coalesce_orders_text_before_a_following_error(tmp_path: Path) -> None:
    out = _coalesce(
        [
            _ev(type="text-start", id="0"),
            _ev(type="text-delta", id="0", delta="hi"),
            _ev(type="error", errorText="boom"),
        ],
        tmp_path / "cell",
    )
    assert [r["kind"] for r in out] == ["assistant_text", "error"]  # chronology preserved
    assert out[0]["text"] == "hi" and out[1]["error"] == "boom"


def test_coalesce_tool_output_strips_provider_metadata(tmp_path: Path) -> None:
    out = _coalesce(
        [
            _ev(
                type="tool-output-available",
                toolCallId="t1",
                output="ok",
                providerMetadata={"google": {"thoughtSignature": "BIG"}},
            )
        ],
        tmp_path / "cell",
    )
    assert [r["kind"] for r in out] == ["tool_output"]
    assert out[0]["output"] == "ok" and out[0]["tool_call_id"] == "t1" and "providerMetadata" not in out[0]


def test_coalesce_drops_keepalive_and_framing_noise(tmp_path: Path) -> None:
    out = _coalesce(
        [
            _ev(type="start"),
            _ev(type="start-step"),
            _ev(type="data-heartbeat"),
            _ev(type="data-context-window-estimate", data={"estimatedTokens": 5}),
            _ev(type="finish-step"),  # bare per-step marker, no finishReason
            ChatStreamRecord(kind="ignored", raw="data: [DONE]", reason="done"),
        ],
        tmp_path / "cell",
    )
    assert out == []


def test_coalesce_finish_step_with_reason_becomes_finish(tmp_path: Path) -> None:
    out = _coalesce(
        [_ev(type="finish-step", finishReason="tool-calls"), _ev(type="finish", finishReason="stop")],
        tmp_path / "cell",
    )
    assert [(r["kind"], r["finish_reason"]) for r in out] == [("finish", "tool-calls"), ("finish", "stop")]


def test_coalesce_emits_token_usage(tmp_path: Path) -> None:
    out = _coalesce([_ev(type="data-token-usage", data={"totalTokens": 1234})], tmp_path / "cell")
    assert [r["kind"] for r in out] == ["token_usage"] and out[0]["total_tokens"] == 1234


def test_coalesce_passes_unknown_event_through_verbatim(tmp_path: Path) -> None:
    # an unrecognized type (e.g. a tool error carrying errorText) is preserved, never silently dropped.
    event = {"type": "tool-output-error", "toolCallId": "t1", "errorText": "boom"}
    out = _coalesce([_ev(**event)], tmp_path / "cell")
    assert [r["kind"] for r in out] == ["chat_stream"] and out[0]["event"] == event


def test_coalesce_flush_emits_dangling_text(tmp_path: Path) -> None:
    out = _coalesce(
        [_ev(type="text-start", id="0"), _ev(type="text-delta", id="0", delta="partial")], tmp_path / "cell"
    )
    assert [r["kind"] for r in out] == ["assistant_text"] and out[0]["text"] == "partial"


def test_coalesce_preserves_parse_error(tmp_path: Path) -> None:
    out = _coalesce(
        [ChatStreamRecord(kind="parse_error", raw="data: {bad", reason="boom")], tmp_path / "cell"
    )
    assert [r["kind"] for r in out] == ["parse_error"]
    assert out[0]["raw"] == "data: {bad" and out[0]["reason"] == "boom"


class _DropStreamClient:
    """Stand-in for the chat network boundary: yields some records, then the stream drops."""

    def __init__(self, records: list[ChatStreamRecord]) -> None:
        self._records = records

    def stream_chat_records(
        self, conversation_id: str, *, text: str, files: tuple[object, ...] = ()
    ) -> Iterator[ChatStreamRecord]:
        yield from self._records
        raise ArchestraApiError("POST", "http://x/api/chat", 0, "chat stream interrupted")


def test_drive_stage_flushes_dangling_text_on_stream_drop(tmp_path: Path) -> None:
    artifacts = _RunArtifacts(tmp_path / "cell")
    client = _DropStreamClient([_ev(type="text-start", id="0"), _ev(type="text-delta", id="0", delta="half")])
    run = ChatRunResult(text="")
    error = _drive_stage(client, "conv-1", Stage(text="hello"), _task("t"), run, artifacts, {})
    assert error is not None  # the stream drop surfaces as an error string
    out = [json.loads(line) for line in (tmp_path / "cell" / "trajectory.jsonl").read_text().splitlines()]
    assert [r["kind"] for r in out] == ["assistant_text"]  # flushed in the finally despite the drop
    assert out[0]["text"] == "half"


class _StaticStreamClient:
    """Network boundary that replays one canned stream per stage call (no real chat)."""

    def __init__(self, stages: list[list[ChatStreamRecord]]) -> None:
        self._stages = iter(stages)

    def stream_chat_records(
        self, conversation_id: str, *, text: str, files: tuple[object, ...] = ()
    ) -> Iterator[ChatStreamRecord]:
        yield from next(self._stages)


def _usage(total: int) -> ChatStreamRecord:
    return _ev(type="data-token-usage", data={"totalTokens": total})


def test_drive_stage_sums_per_stage_totals(tmp_path: Path) -> None:
    # real stream shape: per-step usages (small) then a final terminal aggregate (the stage total).
    # take-last picks the aggregate; the run total sums per-stage aggregates -- never every event.
    artifacts = _RunArtifacts(tmp_path / "cell")
    client = _StaticStreamClient([
        [_usage(50), _usage(70), _usage(180)],  # stage 1: 50,70 per-step; 180 terminal aggregate
        [_usage(60), _usage(150)],              # stage 2: 60 per-step; 150 terminal aggregate
    ])
    run = ChatRunResult(text="")
    for _ in range(2):
        assert _drive_stage(client, "c", Stage(text="go"), _task("t"), run, artifacts, {}) is None
    assert run.total_tokens == 180 + 150  # not 50+70+180+60+150


def test_drive_stage_leaves_total_none_when_provider_emits_no_usage(tmp_path: Path) -> None:
    artifacts = _RunArtifacts(tmp_path / "cell")
    client = _StaticStreamClient([[_ev(type="text-start", id="0")]])
    run = ChatRunResult(text="")
    assert _drive_stage(client, "c", Stage(text="go"), _task("t"), run, artifacts, {}) is None
    assert run.total_tokens is None  # honest: provider reported nothing, not 0
