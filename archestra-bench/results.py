"""Result contract, outcome taxonomy, aggregation, and markdown rendering for the eval matrix."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum


class Outcome(str, Enum):
    """The terminal classification of one agent attempt at a task.

    `passed`/`failed` mean the agent submitted a well-formed result and the out-of-band verifier
    accepted/rejected it. The remaining classes are distinct failure modes that must not be
    conflated with a verifier verdict: the agent never produced a gradeable answer."""

    PASSED = "passed"
    FAILED = "failed"
    FORMAT_FAILED = "format_failed"  # submitted, but never matched the result schema within budget
    NO_SUBMISSION = "no_submission"  # the run finished without ever calling submit_result
    AGENT_ERROR = "agent_error"  # the chat run errored before a result could be graded


@dataclass(frozen=True)
class RunResult:
    """One agent attempt at a task with a specific model, in a specific environment."""

    env_id: str
    task_id: str
    lane: str
    provider: str
    model: str
    outcome: Outcome
    finish_reason: str | None
    tool_call_count: int
    turn_count: int
    total_tokens: int | None
    agent_error: str | None
    stage_count: int
    format_attempts: int
    artifact_dir: str | None = None

    @property
    def verifier_passed(self) -> bool:
        return self.outcome is Outcome.PASSED


def build_report(results: list[RunResult]) -> list[RunResult]:
    """Sort results and reject duplicate (env, task, lane) cells."""
    seen: set[tuple[str, str, str]] = set()
    for result in results:
        key = (result.env_id, result.task_id, result.lane)
        if key in seen:
            raise ValueError(f"duplicate result for {key}")
        seen.add(key)
    return sorted(results, key=lambda result: (result.env_id, result.task_id, result.lane))


@dataclass(frozen=True)
class GroupAggregate:
    """Pass/outcome rollup for one group of cells (an environment or a task)."""

    key: str
    total: int
    passed: int
    outcomes: dict[str, int]

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total else 0.0


@dataclass(frozen=True)
class Aggregate:
    total: int
    passed: int
    outcomes: dict[str, int]
    total_turns: int
    total_tokens: int
    per_env: list[GroupAggregate]
    per_task: list[GroupAggregate]
    per_lane: list[GroupAggregate]

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total else 0.0

    def to_json(self) -> dict[str, object]:
        return {
            "total": self.total,
            "passed": self.passed,
            "pass_rate": self.pass_rate,
            "outcomes": self.outcomes,
            "total_turns": self.total_turns,
            "total_tokens": self.total_tokens,
            "per_env": [_group_json("env_id", g) for g in self.per_env],
            "per_task": [_group_json("task_id", g) for g in self.per_task],
            "per_lane": [_group_json("lane", g) for g in self.per_lane],
        }


def _group_json(key_name: str, group: GroupAggregate) -> dict[str, object]:
    return {
        key_name: group.key,
        "total": group.total,
        "passed": group.passed,
        "pass_rate": group.pass_rate,
        "outcomes": group.outcomes,
    }


def aggregate(results: list[RunResult]) -> Aggregate:
    """Roll results up into per-environment, per-task, and overall outcome breakdowns."""
    return Aggregate(
        total=len(results),
        passed=sum(r.verifier_passed for r in results),
        outcomes=_outcome_counts(results),
        total_turns=sum(r.turn_count for r in results),
        total_tokens=sum(r.total_tokens or 0 for r in results),
        per_env=_group_by(results, lambda r: r.env_id),
        per_task=_group_by(results, lambda r: r.task_id),
        per_lane=_group_by(results, lambda r: r.lane),
    )


def _group_by(results: list[RunResult], key: Callable[[RunResult], str]) -> list[GroupAggregate]:
    grouped: dict[str, list[RunResult]] = {}
    for result in results:
        grouped.setdefault(key(result), []).append(result)
    return [
        GroupAggregate(
            key=group_key,
            total=len(rows),
            passed=sum(r.verifier_passed for r in rows),
            outcomes=_outcome_counts(rows),
        )
        for group_key, rows in sorted(grouped.items())
    ]


def render_markdown(rows: list[RunResult]) -> str:
    """Render the env x task x model outcome table and the aggregation."""
    lines: list[str] = ["# Archestra benchmark results", ""]

    header = ["env", "task", "lane", "provider/model", "outcome", "finish",
              "tools", "tokens", "stages", "fmt", "agent error", "artifacts"]
    align = ["---", "---", "---", "---", "---", "---", "---:", "---:", "---:", "---:", "---", "---"]
    lines += [
        "## Pass matrix",
        "",
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(align) + " |",
    ]
    for row in rows:
        lines.append(
            f"| {row.env_id} | {row.task_id} | {row.lane} | {row.provider}/{row.model} | {row.outcome.value} | "
            f"{_cell(row.finish_reason)} | {row.tool_call_count} | {_cell(row.total_tokens)} | {row.stage_count} | "
            f"{row.format_attempts} | {_cell(row.agent_error)} | {_cell(row.artifact_dir)} |"
        )

    if rows:
        agg = aggregate(rows)
        lines += ["", "## Aggregate", ""]
        lines.append(f"- overall: {agg.passed}/{agg.total} passed ({agg.pass_rate:.0%})")
        lines.append(f"- outcomes: {_outcome_summary(agg.outcomes)}")
        lines.append(f"- turns: {agg.total_turns}, tokens: {agg.total_tokens}")
        lines += ["", "### By environment", ""]
        lines += [_group_line(g) for g in agg.per_env]
        lines += ["", "### By task", ""]
        lines += [_group_line(g) for g in agg.per_task]
        lines += ["", "### By lane", ""]
        lines += [_group_line(g) for g in agg.per_lane]

    return "\n".join(lines) + "\n"


def _group_line(group: GroupAggregate) -> str:
    return (
        f"- `{group.key}`: {group.passed}/{group.total} passed "
        f"({group.pass_rate:.0%}) - {_outcome_summary(group.outcomes)}"
    )


def _outcome_counts(rows: list[RunResult]) -> dict[str, int]:
    counts = Counter(r.outcome.value for r in rows)
    return {outcome.value: counts[outcome.value] for outcome in Outcome if counts[outcome.value]}


def _outcome_summary(outcomes: dict[str, int]) -> str:
    return ", ".join(f"{name}={count}" for name, count in outcomes.items()) or "-"


_MAX_CELL_WIDTH = 160  # keep the markdown table readable; full values live in run.json artifacts


def _cell(value: object | None) -> str:
    if value is None:
        return "-"
    # truncate the display text first, THEN escape pipes, so a cut never splits a `\|` escape.
    text = str(value).replace("\n", " ")
    if len(text) > _MAX_CELL_WIDTH:
        text = text[: _MAX_CELL_WIDTH - 1] + "…"
    text = text.replace("|", "\\|")
    return text or "-"
