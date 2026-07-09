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


def count_policy_blocks(logdir: Path, pipeline_name: str, suite_name: str) -> int:
    """Policy-blocked tool calls across every logged episode of this pipeline."""
    blocked = 0
    for result_file in (logdir / pipeline_name / suite_name).rglob("*.json"):
        results = json.loads(result_file.read_text())
        for message in results.get("messages", []):
            error = message.get("error")
            if isinstance(error, str) and error.startswith(POLICY_BLOCK_SENTINEL):
                blocked += 1
    return blocked


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

    print(f"\n== {pipeline.name} vs {attack_name} on {suite_name} ({benchmark_version}) ==")
    print(f"clean utility:        {percent(clean_utility)}")
    print(f"utility under attack: {percent(mean(attacked['utility_results'].values()))}")
    print(f"attack success rate:  {percent(mean(attacked['security_results'].values()))}")
    print(
        "policy-blocked calls: "
        f"{count_policy_blocks(logdir_path, pipeline.name, suite_name)} "
        f"(all logged episodes of this pipeline)"
    )
    print(f"logs: {logdir_path / pipeline.name / suite_name}")
    return 0
