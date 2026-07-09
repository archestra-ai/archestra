"""Real LLM benchmark: AgentDojo's runners with the baton defense in the loop."""

import json
from pathlib import Path

from agentdojo.task_suite.load_suites import get_suite

from baton_dojo.contracts import load_table
from baton_dojo.defense import POLICY_BLOCK_SENTINEL
from baton_dojo.pipeline import build_pipeline


def mean(values) -> float | None:
    values = list(values)
    return sum(values) / len(values) if values else None


def count_policy_blocks(result_files: list[Path]) -> int:
    """Policy-blocked tool calls across exactly the given episode log files."""
    blocked = 0
    for result_file in result_files:
        results = json.loads(result_file.read_text())
        for message in results.get("messages", []):
            error = message.get("error")
            if isinstance(error, str) and error.startswith(POLICY_BLOCK_SENTINEL):
                blocked += 1
    return blocked


def episode_files(logdir: Path, pipeline_name: str, suite_name: str, results, attack_name: str):
    """The log files for exactly the (user_task, injection_task) pairs in `results`.

    Mirrors agentdojo's own path layout (logging.py): one file per pair, named
    by the injection task under the attack directory ('none' when no injection).
    Only files present on disk are returned, so a subset run counts only its
    own episodes, never a prior invocation's.
    """
    base = logdir / pipeline_name / suite_name
    files = []
    for user_task_id, injection_task_id in results["utility_results"]:
        injection = injection_task_id or "none"
        path = base / user_task_id / attack_name / f"{injection}.json"
        if path.exists():
            files.append(path)
    return files


def percent(value: float | None) -> str:
    return "n/a" if value is None else f"{100 * value:.1f}%"


def run_bench(
    suite_name: str,
    benchmark_version: str,
    model: str,
    attack_name: str,
    defense: str,
    unknown_policy: str,
    user_tasks: list[str] | None,
    injection_tasks: list[str] | None,
    logdir: str,
    skip_clean_utility: bool,
) -> int:
    # Importing the attacks package populates the attack registry.
    import agentdojo.attacks  # noqa: F401
    from agentdojo.attacks.attack_registry import load_attack
    from agentdojo.benchmark import (
        benchmark_suite_with_injections,
        benchmark_suite_without_injections,
    )
    from agentdojo.logging import OutputLogger

    suite = get_suite(benchmark_version, suite_name)
    table = load_table(suite_name)
    table.check_covers({tool.name for tool in suite.tools})
    pipeline = build_pipeline(model, table, defense, unknown_policy)
    attack = load_attack(attack_name, suite, pipeline)
    logdir_path = Path(logdir)

    clean_utility = None
    run_files = []
    # The runners log through the active OutputLogger context, like
    # agentdojo's own CLI wraps them.
    with OutputLogger(str(logdir_path)):
        if not skip_clean_utility:
            clean = benchmark_suite_without_injections(
                pipeline,
                suite,
                logdir=logdir_path,
                force_rerun=False,
                user_tasks=user_tasks,
                benchmark_version=benchmark_version,
            )
            clean_utility = mean(clean["utility_results"].values())
            run_files += episode_files(
                logdir_path, pipeline.name, suite_name, clean, "none"
            )

        attacked = benchmark_suite_with_injections(
            pipeline,
            suite,
            attack,
            logdir=logdir_path,
            force_rerun=False,
            user_tasks=user_tasks,
            injection_tasks=injection_tasks,
            benchmark_version=benchmark_version,
        )
        run_files += episode_files(
            logdir_path, pipeline.name, suite_name, attacked, attack_name
        )

    print(f"\n== {pipeline.name} vs {attack_name} on {suite_name} ({benchmark_version}) ==")
    print(f"clean utility:        {percent(clean_utility)}")
    print(f"utility under attack: {percent(mean(attacked['utility_results'].values()))}")
    print(f"attack success rate:  {percent(mean(attacked['security_results'].values()))}")
    # These episodes back the utility/ASR above; with force_rerun=False a pair
    # already on disk is loaded from cache, so the count is exactly as
    # cached-or-fresh as those metrics — never a different run's episodes.
    print(
        f"policy-blocked calls: {count_policy_blocks(run_files)} "
        f"(across the {len(run_files)} episodes behind these results)"
    )
    print(f"logs: {logdir_path / pipeline.name / suite_name}")
    return 0
