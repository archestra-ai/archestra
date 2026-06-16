"""Run env-configured benchmark environments against a fresh isolated Archestra, verify out of band.

The harness starts the harness-owned benchmark MCP (`submit_result`) in-process, then for each
selected environment (see envs.py):
  - boots a fresh backend on a new port over a fresh, migrated database, reusing the dev stack's
    shared Postgres + Dagger engine (see lifecycle.py);
  - seeds an LLM provider key + models, the env's web-pinned skills, its remote MCP servers, and the
    benchmark MCP, then creates the env's agent and locks its tool surface;
  - drives each task's multi-stage conversation per lane (a named (provider, model) endpoint from
    lanes.toml), capturing the trajectory;
  - reads the submission (and, for file-producing tasks, downloads the produced artifact) and
    verifies out of band;
  - tears the instance down.
Results are written per cell and aggregated by environment and by task.

The sweep is `env x lane`. Lanes run concurrently up to `--max-workers` (default 1 = serial); each
lane runs its env's tasks serially against its own benchmark MCP + agent. A clean env can share one
backend across its lanes (`share_backend` in its toml); a mutating env keeps a backend per lane.

Lanes are defined in lanes.toml (a named provider/model/base_url/key per `[[lane]]`); `--lanes`
selects a subset by name (default: all), so you can keep many lanes and run one.

  export ANTHROPIC_API_KEY=<key>
  uv run run.py --env basic --lanes sonnet
  # run several lanes concurrently (each lane carries its own gateway + key in lanes.toml):
  uv run run.py --env basic --lanes kimi,gemini-flash,or-free --max-workers 3
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import signal
import subprocess
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import cast

# reuse the migration-kit zero-dependency client by importing it off sys.path (no extraction).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "migration-kit" / "scripts"))

import coloredlogs
import fire
from joblib import Parallel, delayed
from tqdm import tqdm
from tqdm.contrib.logging import logging_redirect_tqdm

import tomlconf
from archestra_client import AgentCreate, ArchestraApiError
from benchmark_mcp import BenchmarkMcp, SubmissionAccepted, SubmissionFormatFailed
from contracts import JsonValue, Provider
from envs import EnvConfig, load_envs
from eval_client import ChatRunResult, ChatStreamRecord, EvalClient, FilePart, _apply_chat_event
from lifecycle import Instance
from results import Outcome, RunResult, aggregate, build_report, render_markdown
from seeding import (
    RegisteredMcp,
    ResolvedModel,
    ensure_provider_and_models,
    register_remote_mcp,
    seed_mcp_fixtures,
    seed_skill_ref,
)
from tasks import Stage, Task
from verify import VerifyOutcome, run_verifier

logger = logging.getLogger(__name__)

_ENVS_DIR = Path(__file__).resolve().parent / "envs"
_LANES_TOML = Path(__file__).resolve().parent / "lanes.toml"
_BENCH_MCP_NAME = "benchmark"
_SUBMIT_TOOL_SUFFIX = "__submit_result"
_STATE_NAME = "state.json"
_RUNTIME_PLACEHOLDER = re.compile(r"\{\{(cell|agent_id)\}\}")

_REQUIRED_TOOL_SHORT_NAMES = (
    "artifact_write",
    "todo_write",
    "run_command",
    "upload_file",
    "download_file",
    "list_skills",
    "load_skill",
)
_MUTATING_SKILL_TOOL_SHORT_NAMES = ("create_skill", "update_skill")
_MAX_WORKERS_CAP = 4  # auto default fans out one worker per lane up to this cap


@dataclass(frozen=True)
class Lane:
    """one named (provider, model) endpoint the sweep runs; combined with each env to form the
    parallel units. `name` is a unique slug from lanes.toml and doubles as the lane's stable
    identity, so two lanes that share a provider+model (e.g. distinct Anthropic-compatible gateways)
    never collide on an agent, MCP catalog, log, or artifact dir."""

    name: str
    provider: str
    model: str
    base_url: str | None = None
    api_key_env: str | None = None

    @property
    def slug(self) -> str:
        return _slug(self.name)

    @property
    def key_env(self) -> str:
        return self.api_key_env or f"{self.provider.upper()}_API_KEY"


@dataclass(frozen=True)
class EnvPlan:
    """one env plus the lanes to run against it (the full lane set) and whether they share a backend."""

    env: EnvConfig
    tasks: tuple[Task, ...]
    lanes: tuple[Lane, ...]

    @property
    def share_backend(self) -> bool:
        return self.env.share_backend


def _load_lanes(path: Path, select: str | list[str] | tuple[str, ...] | None) -> list[Lane]:
    """Load the lane catalog from `lanes.toml` and return the selected subset (`--lanes name,...`,
    default: all). Each `[[lane]]` is a named (provider, model) endpoint; names are unique slugs and
    the selection handles, so the same provider+model can appear twice under different gateways."""
    rows = tomlconf.rows(tomlconf.parse_toml(path), "lane", path.name)
    if not rows:
        raise SystemExit(f"{path.name}: no [[lane]] defined")
    catalog: dict[str, Lane] = {}
    for row in rows:
        ctx = f"{path.name}: lane"
        name = tomlconf.req_str(row, "name", ctx)
        if not tomlconf.is_slug(name):
            raise SystemExit(f"{ctx}: name {name!r} must be a slug ([a-z0-9][a-z0-9-]*)")
        if name in catalog:
            raise SystemExit(f"{path.name}: duplicate lane name {name!r}")
        ctx = f"{path.name}: lane {name!r}"
        catalog[name] = Lane(
            name=name,
            provider=_as_provider(tomlconf.req_str(row, "provider", ctx)),
            model=tomlconf.req_str(row, "model", ctx),
            base_url=tomlconf.opt_str(row, "base_url", ctx),
            api_key_env=tomlconf.opt_str(row, "api_key_env", ctx),
        )
    names = _split_names(select)
    if names is None:
        return list(catalog.values())
    unknown = [name for name in names if name not in catalog]
    if unknown:
        raise SystemExit(f"unknown lane(s) {unknown}; choose from {sorted(catalog)}")
    return [catalog[name] for name in names]


def _build_run_plan(selected: list[tuple[EnvConfig, list[Task]]], lanes: list[Lane]) -> list[EnvPlan]:
    """Fan every lane over every selected env -> one EnvPlan per env (carrying its share_backend flag)."""
    return [EnvPlan(env=env, tasks=tuple(tasks), lanes=tuple(lanes)) for env, tasks in selected]


def main(
    env: str | list[str] | tuple[str, ...] | None = None,
    task: str | list[str] | tuple[str, ...] | None = None,
    lanes: str | list[str] | tuple[str, ...] | None = None,
    lanes_file: str | None = None,
    out: str | None = None,
    run_dir: str | None = None,
    max_workers: int | None = None,
) -> int:
    """Run the benchmark sweep: each selected env x lane, where a lane is a named (provider, model)
    endpoint defined in lanes.toml.

    `env`/`task` filter the matrix (one name or comma list each). `--lanes` selects lane names from
    the catalog (default: every lane in the file), so you can define many and run one. `--lanes-file`
    overrides the catalog path (default: archestra-bench/lanes.toml). `--max-workers` runs that many
    lanes concurrently; the default fans out one worker per lane (capped) so a normal multi-lane run
    is parallel out of the box. Each lane runs its env's tasks serially against its own benchmark MCP
    + agent."""
    selected = _select_envs(load_envs(_ENVS_DIR), env, task)
    lane_list = _load_lanes(Path(lanes_file) if lanes_file else _LANES_TOML, lanes)
    workers = _resolve_workers(max_workers, len(lane_list))
    api_keys = {lane.name: _lane_api_key(lane) for lane in lane_list}

    run_id = _run_id()
    root_run_dir = Path(run_dir) if run_dir else _default_run_dir(run_id)
    root_run_dir.mkdir(parents=True, exist_ok=True)
    plan = _build_run_plan(selected, lane_list)
    _write_run_config(
        root_run_dir, run_id=run_id, selected=selected, lanes=lane_list, max_workers=workers,
    )

    ctx = _RunCtx(root_run_dir=root_run_dir, run_id=run_id, api_keys=api_keys)
    results = _execute_plan(plan, ctx, max_workers=workers)

    report = render_markdown(build_report(results))
    _write_report(report, out)
    (root_run_dir / "aggregate.json").write_text(
        json.dumps(aggregate(results).to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0 if all(r.verifier_passed for r in results) else 1


def _resolve_workers(requested: int | None, lane_count: int) -> int:
    """Resolve `--max-workers`: an explicit value is validated and honored; the default (None) fans
    out one worker per lane, capped at `_MAX_WORKERS_CAP`."""
    if requested is None:
        return min(lane_count, _MAX_WORKERS_CAP) or 1
    if requested < 1:
        raise SystemExit(f"--max-workers must be >= 1, got {requested}")
    return requested


# === lane execution ===


class ProgressReporter:
    """Thread-safe live progress over `(task, lane)` cells across concurrently running lanes.

    One `tqdm` bar replaces the per-task INFO logs: concurrent worker threads call
    `cell_started`/`cell_finished` under a lock, and the bar's postfix shows the in-flight cells and
    the last completed outcome. Wrap the run loop in `logging_redirect_tqdm()` so setup/teardown logs
    (some emitted from worker threads mid-run) print above the bar instead of corrupting it."""

    def __init__(self, total: int) -> None:
        self._lock = threading.Lock()
        self._bar = tqdm(total=total, desc="tasks", unit="task")
        self._running: dict[str, str] = {}
        self._last = "-"

    def cell_started(self, cell_id: str, label: str) -> None:
        with self._lock:
            self._running[cell_id] = label
            self._refresh()

    def cell_finished(self, cell_id: str, label: str, outcome: Outcome) -> None:
        with self._lock:
            self._running.pop(cell_id, None)
            mark = "✓" if outcome is Outcome.PASSED else "✗"
            suffix = "" if outcome in (Outcome.PASSED, Outcome.FAILED) else f"({outcome.value})"
            self._last = f"{mark} {label}{suffix}"
            self._bar.update(1)
            self._refresh()

    def _refresh(self) -> None:
        cur = ", ".join(sorted(self._running.values())) or "-"
        self._bar.set_postfix_str(f"cur={cur} last={self._last}", refresh=True)

    def close(self) -> None:
        self._bar.close()

    def __enter__(self) -> ProgressReporter:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _cell_id(task: Task, lane: Lane) -> str:
    return f"{lane.slug}/{task.id}"


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


@dataclass(frozen=True)
class _RunCtx:
    """Run-wide config threaded into every lane unit."""

    root_run_dir: Path
    run_id: str
    api_keys: dict[str, str]  # keyed by lane name


def _execute_plan(plan: list[EnvPlan], ctx: _RunCtx, *, max_workers: int) -> list[RunResult]:
    """Build one work unit per (env, lane) and run them on joblib's threading backend, bounded by
    `max_workers`. joblib preserves submission order, so flattening the results is deterministic
    regardless of completion order.

    Shared-backend envs are booted + seeded serially up front and registered on an ExitStack, so a
    mid-sequence boot failure still tears down already-booted instances, and Ctrl+C (propagating out of
    the Parallel call) unwinds the stack rather than stranding a backend. Isolated-env lanes own their
    backend inside the worker thread."""
    units: list[Callable[[], list[RunResult]]] = []
    total_cells = sum(len(env_plan.tasks) for env_plan in plan for _ in env_plan.lanes)
    with contextlib.ExitStack() as stack, logging_redirect_tqdm(), ProgressReporter(total_cells) as reporter:
        for env_plan in plan:
            builder = _shared_env_units if env_plan.share_backend else _isolated_env_units
            units.extend(builder(env_plan, ctx, stack, reporter))
        n_jobs = min(max_workers, len(units)) or 1
        n_lanes = len(plan[0].lanes) if plan else 0
        logger.info(
            "running %s: %s × %s, %s",
            _plural(total_cells, "task"), _plural(len(plan), "env"),
            _plural(n_lanes, "lane"), _plural(n_jobs, "worker"),
        )
        generator = Parallel(n_jobs=n_jobs, backend="threading", return_as="generator")(
            delayed(unit)() for unit in units
        )
        results: list[RunResult] = []
        for lane_results in generator:
            results.extend(lane_results)
        return results


def _shared_env_units(
    env_plan: EnvPlan, ctx: _RunCtx, stack: contextlib.ExitStack, reporter: ProgressReporter
) -> list[Callable[[], list[RunResult]]]:
    """Boot + seed one backend for the env (serial, up front), create a per-lane agent + benchmark MCP,
    and return one thunk per lane that drives that lane's tasks against the shared backend."""
    env = env_plan.env
    log_path = ctx.root_run_dir / f"{_slug(env.id)}.backend.log"
    instance = stack.enter_context(Instance(_repo_root(), run_id=f"{ctx.run_id}-{env.id}", log_path=log_path))
    client = instance.client
    resolved = _resolve_lanes(client, env_plan.lanes, ctx)
    client.enable_skill_defaults()
    for sref in env.skills:
        seed_skill_ref(client, repo=sref.repo, path=sref.path, ref=sref.ref, cap=sref.cap)
    setups: list[tuple[Lane, str, str, BenchmarkMcp]] = []
    for lane in env_plan.lanes:
        mcp = stack.enter_context(BenchmarkMcp(server_name=f"{_BENCH_MCP_NAME}-{lane.slug}"))
        agent_id, submit_tool = _setup_lane_agent(client, env, lane, mcp)
        setups.append((lane, agent_id, submit_tool, mcp))
    if env.mcps:  # one pass assigning the env's remote MCP tools to every lane agent (no dup catalog items)
        seed_mcp_fixtures(client, env.mcps, agent_ids=[agent_id for _, agent_id, _, _ in setups])
    try:  # best-effort, serial, before fan-out: pre-create the shared token so lanes don't race it
        client.warm_user_token()
    except ArchestraApiError:
        logger.exception("warm_user_token failed; lanes may race the gateway-token insert (non-fatal)")
    return [
        _lane_unit(
            env, env_plan.tasks, lane, ctx, reporter,
            _shared_lane_body(
                client, env, env_plan.tasks, lane, mcp, submit_tool, agent_id,
                ctx.root_run_dir, resolved[lane.name], reporter,
            ),
        )
        for lane, agent_id, submit_tool, mcp in setups
    ]


def _shared_lane_body(
    client: EvalClient,
    env: EnvConfig,
    tasks: tuple[Task, ...],
    lane: Lane,
    mcp: BenchmarkMcp,
    submit_tool: str,
    agent_id: str,
    root_run_dir: Path,
    resolved: ResolvedModel,
    reporter: ProgressReporter,
) -> Callable[[list[RunResult]], None]:
    def body(out: list[RunResult]) -> None:
        # own client per lane so concurrent lanes never share one client's mutable state on the
        # shared backend (the agent + MCP were already set up on the shared client, serially).
        with client.sibling() as lane_client:
            _run_lane(lane_client, env, tasks, lane, mcp, submit_tool, agent_id, root_run_dir, resolved, reporter, out)

    return body


def _isolated_env_units(
    env_plan: EnvPlan, ctx: _RunCtx, stack: contextlib.ExitStack, reporter: ProgressReporter
) -> list[Callable[[], list[RunResult]]]:
    """One thunk per lane; each boots + seeds + tears down its own backend inside the worker thread, so
    lanes never share mutable backend state (required for mutating envs)."""
    env = env_plan.env
    return [
        _lane_unit(
            env, env_plan.tasks, lane, ctx, reporter,
            _isolated_lane_body(env, env_plan.tasks, lane, ctx, reporter),
        )
        for lane in env_plan.lanes
    ]


def _isolated_lane_body(
    env: EnvConfig, tasks: tuple[Task, ...], lane: Lane, ctx: _RunCtx, reporter: ProgressReporter
) -> Callable[[list[RunResult]], None]:
    def body(out: list[RunResult]) -> None:
        log_path = ctx.root_run_dir / f"{_slug(env.id)}__{lane.slug}.backend.log"
        with (
            Instance(_repo_root(), run_id=f"{ctx.run_id}-{env.id}-{lane.slug}", log_path=log_path) as instance,
            BenchmarkMcp(server_name=f"{_BENCH_MCP_NAME}-{lane.slug}") as mcp,
        ):
            client = instance.client
            resolved = _resolve_lanes(client, (lane,), ctx)
            client.enable_skill_defaults()
            for sref in env.skills:
                seed_skill_ref(client, repo=sref.repo, path=sref.path, ref=sref.ref, cap=sref.cap)
            agent_id, submit_tool = _setup_lane_agent(client, env, lane, mcp)
            if env.mcps:
                seed_mcp_fixtures(client, env.mcps, agent_ids=[agent_id])
            _run_lane(
                client, env, tasks, lane, mcp, submit_tool, agent_id,
                ctx.root_run_dir, resolved[lane.name], reporter, out,
            )

    return body


def _resolve_lanes(
    client: EvalClient, lanes: tuple[Lane, ...], ctx: _RunCtx
) -> dict[str, ResolvedModel]:
    """Register each lane's provider key (own base_url + key) and resolve its model, keyed by lane name.
    A per-lane key name lets two lanes on the same provider (distinct gateways) coexist on one backend;
    only the first key per provider is marked primary (the backend allows just one primary per provider)."""
    resolved: dict[str, ResolvedModel] = {}
    seen_providers: set[str] = set()
    for lane in lanes:
        is_primary = lane.provider not in seen_providers
        seen_providers.add(lane.provider)
        resolved[lane.name] = ensure_provider_and_models(
            client, provider=_as_provider(lane.provider), api_key=ctx.api_keys[lane.name],
            base_url=lane.base_url, models=[lane.model], key_name=f"bench-{lane.name}",
            is_primary=is_primary,
        )[lane.model]
    return resolved


def _lane_unit(
    env: EnvConfig,
    tasks: tuple[Task, ...],
    lane: Lane,
    ctx: _RunCtx,
    reporter: ProgressReporter,
    body: Callable[[list[RunResult]], None],
) -> Callable[[], list[RunResult]]:
    """Wrap a lane body so an infra failure (boot/seed/setup) is logged and turned into an `infra:`
    AGENT_ERROR result per not-yet-run task -- isolating the failure so sibling lanes keep going and
    leaving a per-cell record so no `(env,task,provider,model)` cell silently vanishes from the run."""

    def run() -> list[RunResult]:
        out: list[RunResult] = []
        try:
            body(out)
        except (Exception, SystemExit) as exc:  # noqa: BLE001 -- per-lane isolation; KeyboardInterrupt still propagates
            # SystemExit too: seeding/model-sync raise it (e.g. a model that never syncs), and one bad
            # lane must not abort the whole sweep -- it becomes an infra: result like any boot failure.
            logger.exception("lane %s / %s aborted (infra)", env.id, lane.name)
            done = {result.task_id for result in out}
            for task in tasks:
                if task.id in done:
                    continue
                # tasks that ran already advanced the bar in _run_lane; advance it for the rest so a
                # boot/seed failure still drives the bar to 100% instead of stranding the lane's cells.
                out.append(_infra_failed(env, task, lane, ctx.root_run_dir, exc))
                reporter.cell_finished(_cell_id(task, lane), task.id, Outcome.AGENT_ERROR)
        return out

    return run


def _run_lane(
    client: EvalClient,
    env: EnvConfig,
    tasks: tuple[Task, ...],
    lane: Lane,
    mcp: BenchmarkMcp,
    submit_tool: str,
    agent_id: str,
    root_run_dir: Path,
    resolved: ResolvedModel,
    reporter: ProgressReporter,
    out: list[RunResult],
) -> None:
    """Run the lane's tasks serially against its own MCP + agent, appending each result to `out` (so a
    mid-lane failure keeps the results already produced)."""
    for task in tasks:
        cell = _cell_id(task, lane)
        reporter.cell_started(cell, task.id)
        result = _run_one(
            client=client,
            bench_mcp=mcp,
            submit_tool=submit_tool,
            root_run_dir=root_run_dir,
            env_id=env.id,
            lane=lane,
            agent_id=agent_id,
            task=task,
            resolved=resolved,
        )
        out.append(result)
        reporter.cell_finished(cell, task.id, result.outcome)


def _infra_failed(env: EnvConfig, task: Task, lane: Lane, root_run_dir: Path, exc: BaseException) -> RunResult:
    """Persist a minimal per-cell record (run.json + a trajectory line) for a cell whose lane failed
    before it could run, and return an AGENT_ERROR result tagged `infra:`."""
    error = f"infra: {exc}"
    subdir = root_run_dir / _run_subdir(env.id, task.id, lane)
    subdir.mkdir(parents=True, exist_ok=True)
    stamp = _timestamp()
    metadata: dict[str, JsonValue] = {
        "env_id": env.id, "task_id": task.id, "lane": lane.name, "provider": lane.provider, "model": lane.model,
        "outcome": Outcome.AGENT_ERROR.value, "agent_error": error, "finished_at": stamp,
    }
    (subdir / "run.json").write_text(
        json.dumps(metadata, allow_nan=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    with (subdir / "trajectory.jsonl").open("a", encoding="utf-8") as handle:
        json.dump({"sequence": 1, "timestamp": stamp, "kind": "infra_error", "error": error}, handle, sort_keys=True)
        handle.write("\n")
    return RunResult(
        env_id=env.id, task_id=task.id, lane=lane.name, provider=lane.provider, model=lane.model,
        outcome=Outcome.AGENT_ERROR, finish_reason=None, tool_call_count=0, turn_count=0, total_tokens=None,
        agent_error=error, stage_count=len(task.stages), format_attempts=0, artifact_dir=str(subdir),
    )


# === per-cell run ===


def _run_one(
    *,
    client: EvalClient,
    bench_mcp: BenchmarkMcp,
    submit_tool: str,
    root_run_dir: Path,
    env_id: str,
    lane: Lane,
    agent_id: str,
    task: Task,
    resolved: ResolvedModel,
) -> RunResult:
    cell_key = f"{env_id}/{task.id}/{lane.slug}"
    artifacts = _RunArtifacts(root_run_dir / _run_subdir(env_id, task.id, lane))
    artifact_paths: dict[str, JsonValue] = {}
    metadata: dict[str, JsonValue] = {
        "env_id": env_id,
        "task_id": task.id,
        "lane": lane.name,
        "provider": lane.provider,
        "model": lane.model,
        "model_id": resolved.model_id,
        "chat_api_key_id": resolved.api_key_id,
        "submit_tool": submit_tool,
        "conversation_id": None,
        "started_at": _timestamp(),
        "finished_at": None,
        "stage_count": len(task.stages),
        "outcome": None,
        "finish_reason": None,
        "tool_call_count": 0,
        "turn_count": 0,
        "total_tokens": None,
        "format_attempts": 0,
        "agent_error": None,
        "verifier_exit_code": None,
        "verifier_timed_out": None,
        "artifacts": artifact_paths,
    }
    artifacts.write_run(metadata)

    # the cell is the per-cell robustness boundary: an unexpected error here (e.g. a non-API exception
    # from the verifier subprocess, or a malformed conversation payload) finalizes THIS cell as an
    # infra: agent_error using its own artifacts, so it never propagates to clobber a sibling cell.
    try:
        return _grade_cell(
            client, bench_mcp, submit_tool, env_id, lane, agent_id, task, resolved,
            artifacts, metadata, artifact_paths, cell_key,
        )
    except Exception as exc:  # noqa: BLE001 -- per-cell boundary; KeyboardInterrupt still propagates
        return _agent_error(env_id, lane, task, f"infra: {exc}", artifacts, metadata, run=None)


def _grade_cell(
    client: EvalClient,
    bench_mcp: BenchmarkMcp,
    submit_tool: str,
    env_id: str,
    lane: Lane,
    agent_id: str,
    task: Task,
    resolved: ResolvedModel,
    artifacts: _RunArtifacts,
    metadata: dict[str, JsonValue],
    artifact_paths: dict[str, JsonValue],
    cell_key: str,
) -> RunResult:
    """Drive one cell's conversation and grade it. May raise; `_run_one` is the boundary that turns an
    unexpected error into a clean per-cell agent_error."""
    bench_mcp.begin_task(task_key=cell_key, schema=task.result_schema, max_attempts=task.max_format_attempts)

    try:
        conversation = client.create_conversation(
            agent_id,
            title=cell_key,
            model_id=resolved.model_id,
            chat_api_key_id=resolved.api_key_id,
        )
    except ArchestraApiError as exc:
        return _agent_error(env_id, lane, task, _api_error_text(exc), artifacts, metadata, run=None)

    conversation_id = _require_str(conversation, "id")
    metadata["conversation_id"] = conversation_id
    artifacts.append("conversation_created", {"conversation_id": conversation_id})
    artifacts.write_run(metadata)

    runtime = {"cell": _cell_token(cell_key, lane.model), "agent_id": agent_id}
    run = ChatRunResult(text="")
    stage_error: str | None = None
    final_stage = len(task.stages) - 1
    for index, stage in enumerate(task.stages):
        if index == final_stage:  # arm submission only for the last stage; earlier ones must not lock
            bench_mcp.allow_submission(cell_key)
        stage_error = _drive_stage(client, conversation_id, stage, task, run, artifacts, runtime)
        if stage_error is not None:
            break
        artifacts.append("stage_complete", {"stage": index, "finish_reason": run.finish_reason})

    metadata["finish_reason"] = run.finish_reason
    metadata["tool_call_count"] = len(run.tool_calls)
    metadata["turn_count"] = run.turn_count
    metadata["total_tokens"] = run.total_tokens

    # classify by submission first: a well-formed answer captured before a later stage's stream
    # error is still gradeable. agent_error is only for a run that errored without ever submitting.
    submission = bench_mcp.take_submission(cell_key)
    if isinstance(submission, SubmissionFormatFailed):
        metadata["format_errors"] = list(submission.errors)
        return _finish(
            env_id, lane, task, Outcome.FORMAT_FAILED, run, artifacts, metadata,
            format_attempts=submission.attempts,
        )
    if submission is None:
        if stage_error is not None:
            return _agent_error(env_id, lane, task, stage_error, artifacts, metadata, run=run)
        return _finish(
            env_id, lane, task, Outcome.NO_SUBMISSION, run, artifacts, metadata, format_attempts=0
        )

    assert isinstance(submission, SubmissionAccepted)
    metadata["format_attempts"] = submission.attempts
    metadata["result"] = json.loads(submission.payload_bytes)  # the graded answer, inline for triage
    report_path = artifacts.write_bytes("submission.json", submission.payload_bytes)
    artifact_paths["submission"] = str(report_path)

    artifact_bytes: bytes | None = None
    if task.artifact_key is not None:
        try:
            artifact_bytes = _resolve_artifact(
                client, conversation_id, task, submission.payload_bytes, artifacts, artifact_paths
            )
        except ArchestraApiError as exc:
            return _agent_error(
                env_id, lane, task, f"artifact retrieval failed: {_api_error_text(exc)}",
                artifacts, metadata, run=run,
            )

    state_bytes: bytes | None = None
    if task.state_rest:
        try:
            state_bytes = _capture_state(client, task, runtime, run.tool_invocations, artifacts, artifact_paths)
        except ArchestraApiError as exc:
            return _agent_error(
                env_id, lane, task, f"state capture failed: {_api_error_text(exc)}",
                artifacts, metadata, run=run,
            )

    outcome = run_verifier(task, submission.payload_bytes, artifact_bytes=artifact_bytes, state_bytes=state_bytes)
    _save_verifier_artifacts(artifacts, artifact_paths, outcome)
    metadata["verifier_exit_code"] = outcome.exit_code
    metadata["verifier_timed_out"] = outcome.timed_out
    if not outcome.passed:
        metadata["verifier_summary"] = _verifier_summary(outcome)
    return _finish(
        env_id,
        lane,
        task,
        Outcome.PASSED if outcome.passed else Outcome.FAILED,
        run,
        artifacts,
        metadata,
        format_attempts=submission.attempts,
    )


def _resolve_artifact(
    client: EvalClient,
    conversation_id: str,
    task: Task,
    payload_bytes: bytes,
    artifacts: _RunArtifacts,
    artifact_paths: dict[str, JsonValue],
) -> bytes | None:
    """Download the artifact the submission names via `task.artifact_key`.

    Returns None (and logs the reason) when the agent did not deliver the named file -- a missing
    key or a name that matches zero or multiple generated artifacts -- so the verifier fails cleanly
    on a missing BENCH_OUTPUT. A backend HTTP error listing/downloading is NOT the agent's fault;
    it raises ArchestraApiError, which the caller records as an agent_error (not a graded FAILED)."""
    assert task.artifact_key is not None
    result = json.loads(payload_bytes)
    filename = result.get(task.artifact_key) if isinstance(result, dict) else None
    if not isinstance(filename, str):
        artifacts.append_error("artifact_missing", f"submission has no string {task.artifact_key!r}")
        return None
    files = client.list_conversation_files(conversation_id)
    generated = files.get("generated")
    rows = generated if isinstance(generated, list) else []
    matches = [g for g in rows if isinstance(g, dict) and g.get("name") == filename]
    if len(matches) != 1:
        artifacts.append_error(
            "artifact_missing", f"expected exactly one generated artifact named {filename!r}, found {len(matches)}"
        )
        return None
    content_url = matches[0].get("contentUrl")
    if not isinstance(content_url, str):
        artifacts.append_error("artifact_missing", f"generated artifact {filename!r} has no contentUrl")
        return None
    data = client.download_file_bytes(content_url)
    artifact_paths["artifact"] = str(artifacts.write_bytes("artifact.bin", data))
    return data


def _capture_state(
    client: EvalClient,
    task: Task,
    runtime: dict[str, str],
    tool_invocations: list[dict[str, JsonValue]],
    artifacts: _RunArtifacts,
    artifact_paths: dict[str, JsonValue],
) -> bytes:
    """Snapshot the task's declared REST paths plus the run's tool calls into the BENCH_STATE bundle.

    Each `state_rest` template is resolved against the run's `{{cell}}`/`{{agent_id}}` values, GET as
    JSON with the privileged client, and bundled with the ordered tool invocations (name + input) so
    the isolated verifier can assert backend state *and* what the agent actually did. A backend HTTP
    error here is infra, not the agent's fault -- ArchestraApiError propagates to an agent_error."""
    rest: dict[str, JsonValue] = {}
    for template in task.state_rest:
        path = _expand_runtime(template, runtime)
        rest[path] = client.get_json(path)
    bundle: dict[str, JsonValue] = {"rest": rest, "tool_calls": list(tool_invocations)}
    data = json.dumps(bundle, allow_nan=False, sort_keys=True).encode("utf-8")
    artifact_paths["state"] = str(artifacts.write_bytes(_STATE_NAME, data))
    return data


def _drive_stage(
    client: EvalClient,
    conversation_id: str,
    stage: Stage,
    task: Task,
    run: ChatRunResult,
    artifacts: _RunArtifacts,
    runtime: dict[str, str],
) -> str | None:
    """Send one stage's user message and drain the chat stream to EOF, folding events into `run`.

    Returns an error string if the chat stream itself errored, else None."""
    files = tuple(
        FilePart(
            filename=PurePosixPath(f.dest).name,
            mime_type=f.mime_type,
            data=(task.inputs_dir / f.src).read_bytes(),
        )
        for f in stage.files
    )
    text = _expand_runtime(stage.text, runtime)
    stream_parse_error: str | None = None
    coalescer = _StreamCoalescer(artifacts)
    run.stage_tokens = None  # this stage's usage accumulates fresh; folded into the run total below
    try:
        for record in client.stream_chat_records(conversation_id, text=text, files=files):
            coalescer.feed(record)
            if record.kind == "event" and record.event is not None:
                _apply_chat_event(run, record.event)
            elif record.kind == "parse_error" and stream_parse_error is None:
                stream_parse_error = record.reason or record.raw or "malformed chat stream data"
    except ArchestraApiError as exc:
        return _api_error_text(exc)
    finally:
        coalescer.flush()
        if run.stage_tokens is not None:
            run.total_tokens = (run.total_tokens or 0) + run.stage_tokens
    return _combine_errors(run.stream_error, _chat_parse_error(stream_parse_error))


# === setup ===


def _ensure_agent(client: EvalClient, name: str, system_prompt: str) -> str:
    existing = [a for a in client.list_agents(name=name) if a.get("name") == name]
    if existing:
        return _require_str(existing[0], "id")
    created = client.create_agent(
        AgentCreate(name=name, scope="org", agentType="agent", systemPrompt=system_prompt)
    )
    return _require_str(created, "id")


def _setup_lane_agent(client: EvalClient, env: EnvConfig, lane: Lane, mcp: BenchmarkMcp) -> tuple[str, str]:
    """Create (idempotently) this lane's own agent and wire it to this lane's own benchmark MCP, so a
    lane's submissions land on its own server -- the per-lane isolation that lets lanes run concurrently
    without the no-task-id `submit_result` being misattributed. Returns (agent_id, submit_tool)."""
    agent_id = _ensure_agent(client, f"{env.agent_name}-{lane.slug}", env.agent_system_prompt)
    submit_tool = _setup_agent_tools(
        client, agent_id, mcp.base_url(), env.tools, mcp_name=f"{_BENCH_MCP_NAME}-{lane.slug}"
    )
    return agent_id, submit_tool


def _setup_agent_tools(
    client: EvalClient, agent_id: str, bench_url: str, extra_tools: tuple[str, ...], *, mcp_name: str = _BENCH_MCP_NAME
) -> str:
    """Assign the base sandbox tools plus the env's extra `archestra__*` tools (bulk-assign) and the
    benchmark `submit_result` tool (assigned at MCP install time, since remote MCP tools cannot be
    bulk-assigned) to the eval agent, then assert the surface. Returns the submit_result tool name.

    `extra_tools` is the env's allow-list: the only short names beyond the base required set the agent
    may keep -- so a mutating skill tool survives the strip/assert guard iff the env explicitly lists
    it. `mcp_name` is the benchmark MCP's catalog name; lanes sharing a backend must pass a unique name
    to avoid colliding on one catalog item."""
    tool_ids = _resolve_tool_ids(client, (*_REQUIRED_TOOL_SHORT_NAMES, *extra_tools))
    _assign_tools(client, agent_id, list(tool_ids.values()))
    registered = register_remote_mcp(client, name=mcp_name, server_url=bench_url, agent_ids=[agent_id])
    submit_tool, _ = _submit_tool(registered)
    allowed = frozenset(f"archestra__{n}" for n in extra_tools)
    _strip_mutating_skill_tools(client, agent_id, allowed)
    _assert_agent_tool_surface(client, agent_id, submit_tool, allowed)
    return submit_tool


def _tools_to_strip(allowed: frozenset[str]) -> set[str]:
    """The mutating skill tools `enable_skill_defaults` backfills that the env did NOT allow.

    The benchmark agent may *use* skills but must not mutate the library, so any mutating tool the
    env's allow-list doesn't permit is unassigned."""
    return {full for n in _MUTATING_SKILL_TOOL_SHORT_NAMES if (full := f"archestra__{n}") not in allowed}


def _surface_violations(
    present: set[str], *, required: set[str], allowed: frozenset[str], submit_tool: str
) -> list[str]:
    """Pure check of an assembled agent tool surface (no client): every base-required and env-allowed
    tool must be present, the submit tool must be present, and no mutating skill tool may survive
    unless the env allowed it."""
    violations: list[str] = []
    missing = sorted((required | allowed) - present)
    if missing:
        violations.append(f"missing required tools after assignment: {missing}")
    if submit_tool not in present:
        violations.append(f"benchmark tool {submit_tool!r} was not assigned/discovered")
    mutating = {f"archestra__{n}" for n in _MUTATING_SKILL_TOOL_SHORT_NAMES}
    leaked = sorted((mutating - allowed) & present)
    if leaked:
        violations.append(f"can mutate the skill library via {leaked}; refusing a contaminated surface")
    return violations


def _strip_mutating_skill_tools(client: EvalClient, agent_id: str, allowed: frozenset[str]) -> None:
    strip = _tools_to_strip(allowed)
    for tool in client.list_agent_tools(agent_id):
        if tool.get("name") in strip:
            client.unassign_tool(agent_id, _require_str(tool, "id"))


def _resolve_tool_ids(client: EvalClient, short_names: tuple[str, ...]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for short_name in short_names:
        exact = f"archestra__{short_name}"
        matches = [tool for tool in client.list_tools(search=exact) if tool.get("name") == exact]
        if len(matches) != 1:
            raise SystemExit(f"required tool {exact!r} not found exactly once; is sandbox tooling enabled?")
        resolved[short_name] = _require_str(matches[0], "id")
    return resolved


def _assign_tools(client: EvalClient, agent_id: str, tool_ids: list[str]) -> None:
    if not tool_ids:
        return
    result = client.bulk_assign_tools([{"agentId": agent_id, "toolId": tool_id} for tool_id in tool_ids])
    failed = result.get("failed")
    if isinstance(failed, list) and failed:
        raise SystemExit(f"failed to assign tools to the eval agent: {failed}")


def _assert_agent_tool_surface(
    client: EvalClient, agent_id: str, submit_tool: str, allowed: frozenset[str]
) -> None:
    names = {name for tool in client.list_agent_tools(agent_id) if isinstance(name := tool.get("name"), str)}
    required: set[str] = {f"archestra__{n}" for n in _REQUIRED_TOOL_SHORT_NAMES}
    violations = _surface_violations(names, required=required, allowed=allowed, submit_tool=submit_tool)
    if violations:
        raise SystemExit("eval agent tool surface is invalid: " + "; ".join(violations))


def _submit_tool(registered: RegisteredMcp) -> tuple[str, str]:
    for tool in registered.tools:
        name = tool.get("name")
        if isinstance(name, str) and name.endswith(_SUBMIT_TOOL_SUFFIX):
            return name, _require_str(tool, "id")
    got = [t.get("name") for t in registered.tools]
    raise SystemExit(f"benchmark MCP exposed no {_SUBMIT_TOOL_SUFFIX} tool; got {got}")


# === artifacts ===


@dataclass
class _RunArtifacts:
    path: Path
    sequence: int = 0

    def __post_init__(self) -> None:
        try:
            self.path.mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise FileExistsError(f"run artifact directory already exists: {self.path}") from exc

    def append(self, kind: str, data: dict[str, JsonValue]) -> None:
        self.sequence += 1
        record: dict[str, JsonValue] = {"sequence": self.sequence, "timestamp": _timestamp(), "kind": kind, **data}
        with (self.path / "trajectory.jsonl").open("a", encoding="utf-8") as handle:
            json.dump(record, handle, allow_nan=False, sort_keys=True)
            handle.write("\n")

    def append_error(self, kind: str, message: str) -> None:
        self.append(kind, {"error": message})

    def write_run(self, metadata: dict[str, JsonValue]) -> None:
        tmp = self.path / "run.json.tmp"
        tmp.write_text(json.dumps(metadata, allow_nan=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(self.path / "run.json")

    def write_bytes(self, filename: str, data: bytes) -> Path:
        path = self.path / filename
        path.write_bytes(data)
        return path

    def write_text(self, filename: str, text: str) -> Path:
        path = self.path / filename
        path.write_text(text, encoding="utf-8")
        return path


def _text_block_id(event: dict[str, JsonValue]) -> str:
    tid = event.get("id")
    return tid if isinstance(tid, str) else ""


@dataclass
class _PartialToolCall:
    """A tool call whose input is still streaming in (`tool-input-start`/`-delta`), kept so a stream
    that drops before `tool-input-available` still records the attempted call rather than erasing it."""

    name: str | None
    text: str = ""


@dataclass
class _StreamCoalescer:
    """Fold the token-granular AI-SDK chat stream into message-level trajectory records.

    The raw stream emits one event per token (`text-delta`) and per tool-input fragment
    (`tool-input-delta`), so writing each verbatim bloats `trajectory.jsonl` to thousands of
    near-empty lines. This buffers text deltas and emits one coalesced record per logical event,
    covering the same event types `_apply_chat_event` consumes so the trajectory records the
    logical events grading is driven by. Per-token deltas, keepalive/framing markers, and opaque
    `providerMetadata` are dropped; an unknown event type passes through verbatim so a new SDK
    event is never lost. A tool call interrupted before its input completes is flushed as a
    `tool_call_partial` so a dropped stream leaves a record of the attempt, not silence."""

    artifacts: _RunArtifacts
    _text: dict[str, str] = field(default_factory=dict)
    _tool_input: dict[str, _PartialToolCall] = field(default_factory=dict)

    def feed(self, record: ChatStreamRecord) -> None:
        match record.kind:
            case "parse_error":
                self.artifacts.append("parse_error", {"raw": record.raw, "reason": record.reason})
            case "ignored":
                return
            case "event" if record.event is not None:
                self._feed_event(record.event)

    def _feed_event(self, event: dict[str, JsonValue]) -> None:
        match event.get("type"):
            case "text-start":
                self._text.setdefault(_text_block_id(event), "")
            case "text-delta":
                delta = event.get("delta")
                if not isinstance(delta, str):
                    delta = event.get("text")
                if isinstance(delta, str):
                    tid = _text_block_id(event)
                    self._text[tid] = self._text.get(tid, "") + delta
            case "text-end":
                tid = _text_block_id(event)
                text = self._text.pop(tid, "")
                if text:
                    self.artifacts.append("assistant_text", {"id": tid, "text": text})
            case "tool-input-start":
                call_id = event.get("toolCallId")
                if isinstance(call_id, str):
                    name = event.get("toolName")
                    self._tool_input[call_id] = _PartialToolCall(name=name if isinstance(name, str) else None)
            case "tool-input-delta":
                call_id = event.get("toolCallId")
                fragment = event.get("inputTextDelta")
                if isinstance(call_id, str) and isinstance(fragment, str):
                    self._tool_input.setdefault(call_id, _PartialToolCall(name=None)).text += fragment
            case "tool-input-available" | "tool-call":
                call_id = event.get("toolCallId")
                if isinstance(call_id, str):
                    self._tool_input.pop(call_id, None)  # input completed -> the partial buffer is superseded
                name = event.get("toolName")
                if isinstance(name, str):
                    self.artifacts.append(
                        "tool_call", {"tool_call_id": call_id, "tool_name": name, "input": event.get("input")}
                    )
                else:  # malformed call the grader would skip -- preserve verbatim rather than fabricate one
                    self.artifacts.append("chat_stream", {"event": event})
            case "tool-output-available":
                self.artifacts.append(
                    "tool_output", {"tool_call_id": event.get("toolCallId"), "output": event.get("output")}
                )
            case "finish" | "finish-step":
                reason = event.get("finishReason")
                if isinstance(reason, str):
                    self.artifacts.append("finish", {"finish_reason": reason})
            case "data-token-usage":
                usage = event.get("data")
                if isinstance(usage, dict) and isinstance(usage.get("totalTokens"), int):
                    self.artifacts.append("token_usage", {"total_tokens": usage["totalTokens"]})
            case "error":
                self._flush_text()  # the text streamed before the error -- keep that order on disk
                text = event.get("errorText") or event.get("error")
                self.artifacts.append("error", {"error": text if isinstance(text, str) else json.dumps(event)})
            case "start" | "start-step" | "data-heartbeat" | "data-context-window-estimate":
                return
            case _:
                self.artifacts.append("chat_stream", {"event": event})

    def _flush_text(self) -> None:
        for tid, text in self._text.items():
            if text:
                self.artifacts.append("assistant_text", {"id": tid, "text": text})
        self._text.clear()

    def flush(self) -> None:
        self._flush_text()
        for call_id, partial in self._tool_input.items():
            self.artifacts.append(
                "tool_call_partial", {"tool_call_id": call_id, "tool_name": partial.name, "partial_input": partial.text}
            )
        self._tool_input.clear()


# === result assembly ===


def _agent_error(
    env_id: str,
    lane: Lane,
    task: Task,
    error: str,
    artifacts: _RunArtifacts,
    metadata: dict[str, JsonValue],
    *,
    run: ChatRunResult | None,
) -> RunResult:
    artifacts.append_error("agent_error", error)
    return _finish(
        env_id, lane, task, Outcome.AGENT_ERROR, run, artifacts, metadata,
        format_attempts=0, agent_error=error,
    )


def _finish(
    env_id: str,
    lane: Lane,
    task: Task,
    outcome: Outcome,
    run: ChatRunResult | None,
    artifacts: _RunArtifacts,
    metadata: dict[str, JsonValue],
    *,
    format_attempts: int,
    agent_error: str | None = None,
) -> RunResult:
    metadata["finished_at"] = _timestamp()
    metadata["outcome"] = outcome.value
    metadata["agent_error"] = agent_error
    metadata["format_attempts"] = format_attempts
    artifacts.write_run(metadata)
    return RunResult(
        env_id=env_id,
        task_id=task.id,
        lane=lane.name,
        provider=lane.provider,
        model=lane.model,
        outcome=outcome,
        finish_reason=run.finish_reason if run else None,
        tool_call_count=len(run.tool_calls) if run else 0,
        turn_count=run.turn_count if run else 0,
        total_tokens=run.total_tokens if run else None,
        agent_error=agent_error,
        stage_count=len(task.stages),
        format_attempts=format_attempts,
        artifact_dir=str(artifacts.path),
    )


def _save_verifier_artifacts(
    artifacts: _RunArtifacts, artifact_paths: dict[str, JsonValue], outcome: VerifyOutcome
) -> None:
    artifact_paths["verifier_stdout"] = str(artifacts.write_text("verifier.stdout.txt", outcome.stdout))
    artifact_paths["verifier_stderr"] = str(artifacts.write_text("verifier.stderr.txt", outcome.stderr))


_VERIFIER_SUMMARY_CAP = 500  # enough for the assertion lines; full output lives in verifier.stdout.txt


def _verifier_summary(outcome: VerifyOutcome) -> str:
    """The why-it-failed line(s) for run.json: pytest's `E ` assertion explanation, else the FAILED
    summary, else the tail of stdout/stderr -- so a failure is legible without opening the artifacts."""
    lines = [ln.strip() for ln in outcome.stdout.splitlines() if ln.strip()]
    highlights = [ln for ln in lines if ln.startswith("E ") or ln.startswith("FAILED")]
    if not highlights:
        highlights = lines[-3:] or [ln.strip() for ln in outcome.stderr.splitlines() if ln.strip()][-3:]
    if outcome.timed_out:
        highlights = ["verifier timed out", *highlights]
    text = " | ".join(highlights)
    return text[:_VERIFIER_SUMMARY_CAP] if len(text) > _VERIFIER_SUMMARY_CAP else text


# === helpers ===


def _select_envs(
    envs: dict[str, EnvConfig],
    env: str | list[str] | tuple[str, ...] | None,
    task: str | list[str] | tuple[str, ...] | None,
) -> list[tuple[EnvConfig, list[Task]]]:
    """Resolve the `--env`/`--task` filters to (env, its selected tasks) pairs.

    `env` defaults to all envs; `task` (a global filter) defaults to all tasks in the chosen envs.
    Unknown names or a filter that selects nothing is a hard error -- never a silent empty run."""
    env_names = _split_names(env)
    if env_names is None:
        chosen = [envs[name] for name in sorted(envs)]
    else:
        unknown = [name for name in env_names if name not in envs]
        if unknown:
            raise SystemExit(f"unknown env(s) {unknown}; choose from {sorted(envs)}")
        chosen = [envs[name] for name in env_names]

    task_names = _split_names(task)
    selected: list[tuple[EnvConfig, list[Task]]] = []
    matched: set[str] = set()
    for env_cfg in chosen:
        if task_names is None:
            tasks = list(env_cfg.tasks)
        else:
            tasks = [t for t in env_cfg.tasks if t.id in task_names]
            matched.update(t.id for t in tasks)
        if tasks:
            selected.append((env_cfg, tasks))

    if task_names is not None:
        unknown_tasks = [name for name in task_names if name not in matched]
        if unknown_tasks:
            raise SystemExit(f"task(s) {unknown_tasks} not found in the selected env(s)")
    if not selected:
        raise SystemExit("no tasks selected; check the --env/--task filters")
    return selected


def _split_names(value: str | list[str] | tuple[str, ...] | None) -> list[str] | None:
    """Split a comma-separated string or list into names; None (the default) means 'all'."""
    if value is None:
        return None
    values = [v.strip() for v in value.split(",")] if isinstance(value, str) else [v.strip() for v in value]
    return [v for v in values if v] or None


def _lane_api_key(lane: Lane) -> str:
    key = os.environ.get(lane.key_env)
    if not key:
        raise SystemExit(f"set {lane.key_env} to seed lane {lane.name!r} ({lane.provider})")
    return key


def _as_provider(provider: str) -> Provider:
    # deliberately narrower than contracts.Provider: only the API-key providers the benchmark seeds.
    allowed = ("anthropic", "openai", "gemini", "openrouter")
    if provider not in allowed:
        raise SystemExit(f"unsupported provider {provider!r}; expected one of {allowed}")
    return cast(Provider, provider)


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _default_run_dir(run_id: str) -> Path:
    return Path(__file__).resolve().parent / "experiments" / run_id


def _write_run_config(
    run_dir: Path,
    *,
    run_id: str,
    selected: list[tuple[EnvConfig, list[Task]]],
    lanes: list[Lane],
    max_workers: int,
) -> None:
    config: dict[str, JsonValue] = {
        "run_id": run_id,
        "started_at": _timestamp(),
        "environments": [
            {"id": env_cfg.id, "tasks": [t.id for t in tasks], "share_backend": env_cfg.share_backend}
            for env_cfg, tasks in selected
        ],
        "lanes": [
            {"name": lane.name, "provider": lane.provider, "model": lane.model, "base_url": lane.base_url}
            for lane in lanes
        ],
        "max_workers": max_workers,
        "git_commit": _git_commit(),
    }
    (run_dir / "config.json").write_text(
        json.dumps(config, allow_nan=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _git_commit() -> str | None:
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=_repo_root(), capture_output=True, text=True, timeout=10
    )
    return proc.stdout.strip() or None if proc.returncode == 0 else None


def _write_report(report: str, out: str | None) -> None:
    if out:
        Path(out).write_text(report, encoding="utf-8")
        logger.info("wrote report to %s", out)
    else:
        print(report)


def _run_subdir(env_id: str, task_id: str, lane: Lane) -> str:
    return f"{_slug(env_id)}/{_slug(task_id)}__{lane.slug}"


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return slug or "run"


def _cell_token(cell_key: str, model_name: str) -> str:
    """A skill-name-safe token unique to one (env, task, provider, model) cell, so resources a mutating
    task creates never collide across a multi-lane/multi-task matrix on one shared backend. A readable
    model slug (lossy -- `a.b` and `a-b` collapse) plus a short stable hash of the full cell key,
    which disambiguates both slug collisions and the same model reused across tasks/providers."""
    slug = re.sub(r"[^a-z0-9]+", "-", model_name.lower()).strip("-") or "model"
    digest = hashlib.sha256(cell_key.encode("utf-8")).hexdigest()[:8]
    return f"{slug}-{digest}"


def _expand_runtime(text: str, mapping: dict[str, str]) -> str:
    """Substitute the runtime placeholders `{{cell}}`/`{{agent_id}}` in stage text and state paths.

    Distinct from the load-time `{{file:}}` expansion (tasks.py): these values are only known per cell
    at run time. Unknown `{{...}}` tokens are left untouched."""
    return _RUNTIME_PLACEHOLDER.sub(lambda m: mapping[m.group(1)], text)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _api_error_text(exc: ArchestraApiError) -> str:
    return f"{exc.method} {exc.url} -> {exc.status}: {exc.body}"


def _chat_parse_error(reason: str | None) -> str | None:
    return None if reason is None else f"malformed chat stream data: {reason}"


def _combine_errors(first: str | None, second: str | None) -> str | None:
    match first, second:
        case None, None:
            return None
        case str(value), None:
            return value
        case None, str(value):
            return value
        case str(left), str(right):
            return f"{left}; {right}"


def _require_str(obj: dict[str, JsonValue], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise ArchestraApiError("GET", key, 0, f"expected string field {key!r}, got {value!r}")
    return value


def cli(
    env: str | list[str] | tuple[str, ...] | None = None,
    task: str | list[str] | tuple[str, ...] | None = None,
    lanes: str | list[str] | tuple[str, ...] | None = None,
    lanes_file: str | None = None,
    out: str | None = None,
    run_dir: str | None = None,
    max_workers: int | None = None,
) -> None:
    """Fire entrypoint that preserves `main`'s integer exit code."""
    coloredlogs.install(
        level=logging.INFO,
        fmt="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    # the in-process benchmark MCP server logs transport chatter (session manager, per-request) at
    # INFO via the `mcp` library; raise its floor so it doesn't drown the harness's own progress.
    logging.getLogger("mcp").setLevel(logging.WARNING)
    # SIGINT (Ctrl+C) already unwinds the with-blocks via KeyboardInterrupt; make SIGTERM (`timeout`,
    # `kill`) do the same so the instance is always torn down instead of leaking a backend + database.
    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)
    raise SystemExit(
        main(
            env=env, task=task, lanes=lanes, lanes_file=lanes_file,
            out=out, run_dir=run_dir, max_workers=max_workers,
        )
    )


def _raise_keyboard_interrupt(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    fire.Fire(cli)
