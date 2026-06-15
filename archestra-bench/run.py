"""Run env-configured benchmark environments against a fresh isolated Archestra, verify out of band.

The harness starts the harness-owned benchmark MCP (`submit_result`) in-process, then for each
selected environment (see envs.py):
  - boots a fresh backend on a new port over a fresh, migrated database, reusing the dev stack's
    shared Postgres + Dagger engine (see lifecycle.py);
  - seeds an LLM provider key + models, the env's web-pinned skills, its remote MCP servers, and the
    benchmark MCP, then creates the env's agent and locks its tool surface;
  - drives each task's multi-stage conversation per model, capturing the trajectory;
  - reads the submission (and, for file-producing tasks, downloads the produced artifact) and
    verifies out of band;
  - tears the instance down.
Results are written per cell and aggregated by environment and by task.

  export ANTHROPIC_API_KEY=<key>
  uv run run.py --env basic --model claude-sonnet-4-6
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import cast

# reuse the migration-kit zero-dependency client by importing it off sys.path (no extraction).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "migration-kit" / "scripts"))

import coloredlogs
import fire

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
_DEFAULT_MODEL = "claude-sonnet-4-6"
_DEFAULT_PROVIDER = "anthropic"
_BENCH_MCP_NAME = "benchmark"
_SUBMIT_TOOL_SUFFIX = "__submit_result"

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


def main(
    env: str | list[str] | tuple[str, ...] | None = None,
    task: str | list[str] | tuple[str, ...] | None = None,
    model: str | list[str] | tuple[str, ...] | None = None,
    provider: str = _DEFAULT_PROVIDER,
    base_url: str | None = None,
    out: str | None = None,
    run_dir: str | None = None,
) -> int:
    """Run the benchmark. `env`, `task`, and `model` each take one name or a comma-separated list.

    `env` defaults to every environment; `task` defaults to every task in the selected envs.
    `base_url` overrides the provider's default endpoint -- e.g. point `anthropic` at an
    Anthropic-compatible gateway (Moonshot/Kimi) to benchmark a non-Anthropic model."""
    selected = _select_envs(load_envs(_ENVS_DIR), env, task)
    models = _normalize_models(model)

    api_key = _provider_key_from_env(provider)
    run_id = _run_id()
    root_run_dir = Path(run_dir) if run_dir else _default_run_dir(run_id)
    root_run_dir.mkdir(parents=True, exist_ok=True)
    _write_run_config(
        root_run_dir, run_id=run_id, selected=selected, provider=provider, base_url=base_url, models=models
    )

    results: list[RunResult] = []
    with BenchmarkMcp(server_name=_BENCH_MCP_NAME) as bench_mcp:
        for env_cfg, configs in selected:
            results.extend(
                _run_env(
                    env_cfg=env_cfg,
                    configs=configs,
                    bench_mcp=bench_mcp,
                    root_run_dir=root_run_dir,
                    run_id=run_id,
                    provider=provider,
                    api_key=api_key,
                    base_url=base_url,
                    models=models,
                )
            )

    report = render_markdown(build_report(results))
    _write_report(report, out)
    (root_run_dir / "aggregate.json").write_text(
        json.dumps(aggregate(results).to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0 if all(r.verifier_passed for r in results) else 1


def _run_env(
    *,
    env_cfg: EnvConfig,
    configs: list[Task],
    bench_mcp: BenchmarkMcp,
    root_run_dir: Path,
    run_id: str,
    provider: str,
    api_key: str,
    base_url: str | None,
    models: list[str],
) -> list[RunResult]:
    """Boot one fresh instance for an environment, seed its surface once, run its tasks x models."""
    results: list[RunResult] = []
    log_path = root_run_dir / f"{_slug(env_cfg.id)}.backend.log"
    with Instance(_repo_root(), run_id=f"{run_id}-{env_cfg.id}", log_path=log_path) as instance:
        client = instance.client
        resolved = ensure_provider_and_models(
            client, provider=_as_provider(provider), api_key=api_key, base_url=base_url, models=models
        )
        agent_id = _ensure_agent(client, env_cfg.agent_name, env_cfg.agent_system_prompt)
        client.enable_skill_defaults()
        submit_tool = _setup_agent_tools(client, agent_id, bench_mcp.base_url())
        for sref in env_cfg.skills:
            seed_skill_ref(client, repo=sref.repo, path=sref.path, ref=sref.ref, cap=sref.cap)
        if env_cfg.mcps:
            seed_mcp_fixtures(client, env_cfg.mcps, agent_ids=[agent_id])

        for task in configs:
            for model_name in models:
                logger.info("running %s / %s / %s", env_cfg.id, task.id, model_name)
                results.append(
                    _run_one(
                        client=client,
                        bench_mcp=bench_mcp,
                        submit_tool=submit_tool,
                        root_run_dir=root_run_dir,
                        env_id=env_cfg.id,
                        agent_id=agent_id,
                        task=task,
                        model_name=model_name,
                        resolved=resolved[model_name],
                    )
                )
    return results


# === per-cell run ===


def _run_one(
    *,
    client: EvalClient,
    bench_mcp: BenchmarkMcp,
    submit_tool: str,
    root_run_dir: Path,
    env_id: str,
    agent_id: str,
    task: Task,
    model_name: str,
    resolved: ResolvedModel,
) -> RunResult:
    cell_key = f"{env_id}/{task.id}/{model_name}"
    artifacts = _RunArtifacts(root_run_dir / _run_subdir(env_id, task.id, model_name))
    artifact_paths: dict[str, JsonValue] = {}
    metadata: dict[str, JsonValue] = {
        "env_id": env_id,
        "task_id": task.id,
        "model": model_name,
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
        "total_tokens": None,
        "format_attempts": 0,
        "agent_error": None,
        "verifier_exit_code": None,
        "verifier_timed_out": None,
        "artifacts": artifact_paths,
    }
    artifacts.write_run(metadata)

    bench_mcp.begin_task(task_key=cell_key, schema=task.result_schema, max_attempts=task.max_format_attempts)

    try:
        conversation = client.create_conversation(
            agent_id,
            title=cell_key,
            model_id=resolved.model_id,
            chat_api_key_id=resolved.api_key_id,
        )
    except ArchestraApiError as exc:
        return _agent_error(env_id, task, model_name, _api_error_text(exc), artifacts, metadata, run=None)

    conversation_id = _require_str(conversation, "id")
    metadata["conversation_id"] = conversation_id
    artifacts.append("conversation_created", {"conversation_id": conversation_id})
    artifacts.write_run(metadata)

    run = ChatRunResult(text="")
    stage_error: str | None = None
    for index, stage in enumerate(task.stages):
        stage_error = _drive_stage(client, conversation_id, stage, task, run, artifacts)
        if stage_error is not None:
            break
        artifacts.append("stage_complete", {"stage": index, "finish_reason": run.finish_reason})

    metadata["finish_reason"] = run.finish_reason
    metadata["tool_call_count"] = len(run.tool_calls)
    metadata["total_tokens"] = run.total_tokens

    # classify by submission first: a well-formed answer captured before a later stage's stream
    # error is still gradeable. agent_error is only for a run that errored without ever submitting.
    submission = bench_mcp.take_submission(cell_key)
    if isinstance(submission, SubmissionFormatFailed):
        return _finish(
            env_id, task, model_name, Outcome.FORMAT_FAILED, run, artifacts, metadata,
            format_attempts=submission.attempts,
        )
    if submission is None:
        if stage_error is not None:
            return _agent_error(env_id, task, model_name, stage_error, artifacts, metadata, run=run)
        return _finish(env_id, task, model_name, Outcome.NO_SUBMISSION, run, artifacts, metadata, format_attempts=0)

    assert isinstance(submission, SubmissionAccepted)
    metadata["format_attempts"] = submission.attempts
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
                env_id, task, model_name, f"artifact retrieval failed: {_api_error_text(exc)}",
                artifacts, metadata, run=run,
            )

    outcome = run_verifier(task, submission.payload_bytes, artifact_bytes=artifact_bytes)
    _save_verifier_artifacts(artifacts, artifact_paths, outcome)
    metadata["verifier_exit_code"] = outcome.exit_code
    metadata["verifier_timed_out"] = outcome.timed_out
    if not outcome.passed:
        logger.info("  verifier failed (exit %s)", outcome.exit_code)
    return _finish(
        env_id,
        task,
        model_name,
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


def _drive_stage(
    client: EvalClient,
    conversation_id: str,
    stage: Stage,
    task: Task,
    run: ChatRunResult,
    artifacts: _RunArtifacts,
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
    stream_parse_error: str | None = None
    try:
        for record in client.stream_chat_records(conversation_id, text=stage.text, files=files):
            artifacts.append_stream(record)
            if record.kind == "event" and record.event is not None:
                _apply_chat_event(run, record.event)
            elif record.kind == "parse_error" and stream_parse_error is None:
                stream_parse_error = record.reason or record.raw or "malformed chat stream data"
    except ArchestraApiError as exc:
        return _api_error_text(exc)
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


def _setup_agent_tools(client: EvalClient, agent_id: str, bench_url: str) -> str:
    """Assign the built-in sandbox tools (bulk-assign) and the benchmark `submit_result` tool
    (assigned at MCP install time, since remote MCP tools cannot be bulk-assigned) to the eval
    agent, then assert the surface. Returns the namespaced submit_result tool name."""
    required_ids = _resolve_required_tool_ids(client)
    _assign_tools(client, agent_id, list(required_ids.values()))
    registered = register_remote_mcp(client, name=_BENCH_MCP_NAME, server_url=bench_url, agent_ids=[agent_id])
    submit_tool, _ = _submit_tool(registered)
    _strip_mutating_skill_tools(client, agent_id)
    _assert_agent_tool_surface(client, agent_id, submit_tool)
    return submit_tool


def _strip_mutating_skill_tools(client: EvalClient, agent_id: str) -> None:
    """`enable_skill_defaults` backfills every skill tool, including `create_skill`/`update_skill`.
    The benchmark agent may use skills but must not mutate the library, so unassign those."""
    mutating = {f"archestra__{n}" for n in _MUTATING_SKILL_TOOL_SHORT_NAMES}
    for tool in client.list_agent_tools(agent_id):
        if tool.get("name") in mutating:
            client.unassign_tool(agent_id, _require_str(tool, "id"))


def _resolve_required_tool_ids(client: EvalClient) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for short_name in _REQUIRED_TOOL_SHORT_NAMES:
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


def _assert_agent_tool_surface(client: EvalClient, agent_id: str, submit_tool: str) -> None:
    names = {name for tool in client.list_agent_tools(agent_id) if isinstance(name := tool.get("name"), str)}
    missing = [f"archestra__{n}" for n in _REQUIRED_TOOL_SHORT_NAMES if f"archestra__{n}" not in names]
    if missing:
        raise SystemExit(f"eval agent is missing required tools after assignment: {missing}")
    if submit_tool not in names:
        raise SystemExit(f"benchmark tool {submit_tool!r} was not assigned/discovered; refusing to run")
    mutating = [f"archestra__{n}" for n in _MUTATING_SKILL_TOOL_SHORT_NAMES if f"archestra__{n}" in names]
    if mutating:
        raise SystemExit(f"eval agent can mutate the skill library via {mutating}; refusing a contaminated surface")


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

    def append_stream(self, record: ChatStreamRecord) -> None:
        data: dict[str, JsonValue] = {"record_kind": record.kind}
        if record.event is not None:
            data["event"] = record.event
        if record.raw is not None:
            data["raw"] = record.raw
        if record.reason is not None:
            data["reason"] = record.reason
        self.append("chat_stream", data)

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


# === result assembly ===


def _agent_error(
    env_id: str,
    task: Task,
    model_name: str,
    error: str,
    artifacts: _RunArtifacts,
    metadata: dict[str, JsonValue],
    *,
    run: ChatRunResult | None,
) -> RunResult:
    artifacts.append_error("agent_error", error)
    return _finish(
        env_id, task, model_name, Outcome.AGENT_ERROR, run, artifacts, metadata,
        format_attempts=0, agent_error=error,
    )


def _finish(
    env_id: str,
    task: Task,
    model_name: str,
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
        model=model_name,
        outcome=outcome,
        finish_reason=run.finish_reason if run else None,
        tool_call_count=len(run.tool_calls) if run else 0,
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


def _normalize_models(model: str | list[str] | tuple[str, ...] | None) -> list[str]:
    if model is None:
        return [_DEFAULT_MODEL]
    values = [p.strip() for p in model.split(",")] if isinstance(model, str) else [p.strip() for p in model]
    models = [v for v in values if v]
    if len(models) != len(set(models)):
        raise SystemExit(f"duplicate models are not allowed: {models}")
    return models or [_DEFAULT_MODEL]


def _provider_key_from_env(provider: str) -> str:
    var = f"{provider.upper()}_API_KEY"
    key = os.environ.get(var)
    if not key:
        raise SystemExit(f"set {var} to seed the {provider} provider key")
    return key


def _as_provider(provider: str) -> Provider:
    # deliberately narrower than contracts.Provider: only the API-key providers the benchmark seeds.
    allowed = ("anthropic", "openai", "gemini")
    if provider not in allowed:
        raise SystemExit(f"unsupported provider {provider!r}; expected one of {allowed}")
    return cast(Provider, provider)


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _default_run_dir(run_id: str) -> Path:
    return Path(__file__).resolve().parent / "experiments" / f"run_{run_id}"


def _write_run_config(
    run_dir: Path,
    *,
    run_id: str,
    selected: list[tuple[EnvConfig, list[Task]]],
    provider: str,
    base_url: str | None,
    models: list[str],
) -> None:
    config: dict[str, JsonValue] = {
        "run_id": run_id,
        "started_at": _timestamp(),
        "environments": [
            {"id": env_cfg.id, "tasks": [t.id for t in tasks]} for env_cfg, tasks in selected
        ],
        "provider": provider,
        "base_url": base_url,
        "models": models,
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


def _run_subdir(env_id: str, task_id: str, model_name: str) -> str:
    return f"{_slug(env_id)}/{_slug(task_id)}__{_slug(model_name)}"


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return slug or "run"


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
    model: str | list[str] | tuple[str, ...] | None = None,
    provider: str = _DEFAULT_PROVIDER,
    base_url: str | None = None,
    out: str | None = None,
    run_dir: str | None = None,
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
            env=env, task=task, model=model, provider=provider, base_url=base_url,
            out=out, run_dir=run_dir,
        )
    )


def _raise_keyboard_interrupt(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    fire.Fire(cli)
