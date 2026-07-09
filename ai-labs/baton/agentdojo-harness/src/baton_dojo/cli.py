"""The baton-dojo command."""

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="baton-dojo",
        description="Run the baton IFC policy engine against AgentDojo",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    bench = subparsers.add_parser(
        "bench",
        help="real LLM benchmark via OpenRouter, with or without the baton defense",
    )
    bench.add_argument("--suite", default="workspace")
    bench.add_argument("--benchmark-version", default="v1.2.2")
    bench.add_argument("--model", required=True, help="OpenRouter model id, e.g. openai/gpt-4o-mini")
    bench.add_argument("--attack", default="important_instructions")
    bench.add_argument("--defense", choices=["baton", "none"], default="baton")
    bench.add_argument(
        "--unknown-policy",
        choices=["deny", "allow_with_audit", "escalate"],
        default="allow_with_audit",
    )
    bench.add_argument("--user-tasks", nargs="*", default=None, help="subset of user task ids")
    bench.add_argument(
        "--injection-tasks", nargs="*", default=None, help="subset of injection task ids"
    )
    bench.add_argument("--logdir", default="runs")
    bench.add_argument(
        "--skip-clean-utility",
        action="store_true",
        help="skip the no-injection utility run",
    )

    args = parser.parse_args()
    if args.command == "bench":
        from baton_dojo.bench import run_bench

        sys.exit(
            run_bench(
                suite_name=args.suite,
                benchmark_version=args.benchmark_version,
                model=args.model,
                attack_name=args.attack,
                defense=args.defense,
                unknown_policy=args.unknown_policy,
                user_tasks=args.user_tasks,
                injection_tasks=args.injection_tasks,
                logdir=args.logdir,
                skip_clean_utility=args.skip_clean_utility,
            )
        )
