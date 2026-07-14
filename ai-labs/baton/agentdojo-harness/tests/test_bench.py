"""Network-free unit tests for bench-mode helpers."""

import json

from baton_dojo.bench import count_policy_blocks, episode_files
from baton_dojo.defense import POLICY_BLOCK_SENTINEL


def write_result(path, errors):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"messages": [{"error": error} for error in errors]}))


def test_count_policy_blocks_counts_only_sentinel_errors(tmp_path):
    good = tmp_path / "a.json"
    write_result(good, [None, f"{POLICY_BLOCK_SENTINEL}trust too low", "ValidationError: x"])
    assert count_policy_blocks([good]) == 1


def test_episode_files_scopes_to_this_runs_pairs(tmp_path):
    logdir, name, suite = tmp_path, "pipe", "workspace"
    base = logdir / name / suite
    # This run: user_task_0 x injection_task_0.
    write_result(base / "user_task_0" / "important_instructions" / "injection_task_0.json", [])
    # A stale prior run under the same pipeline dir must be ignored.
    write_result(base / "user_task_9" / "important_instructions" / "injection_task_9.json", [])

    results = {"utility_results": {("user_task_0", "injection_task_0"): True}}
    files = episode_files(logdir, name, suite, results, "important_instructions")
    assert [f.name for f in files] == ["injection_task_0.json"]


def test_episode_files_uses_none_for_clean_runs(tmp_path):
    logdir, name, suite = tmp_path, "pipe", "workspace"
    path = logdir / name / suite / "user_task_0" / "none" / "none.json"
    write_result(path, [f"{POLICY_BLOCK_SENTINEL}blocked"])
    results = {"utility_results": {("user_task_0", ""): True}}
    files = episode_files(logdir, name, suite, results, "none")
    assert count_policy_blocks(files) == 1


def test_openrouter_api_key_strips_quotes(tmp_path, monkeypatch):
    from baton_dojo import pipeline

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text('OPENROUTER_API_KEY="sk-quoted-value"\n')
    monkeypatch.setattr(pipeline, "AI_LABS_ENV", env_file)
    assert pipeline.openrouter_api_key() == "sk-quoted-value"
