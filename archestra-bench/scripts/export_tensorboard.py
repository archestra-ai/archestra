# /// script
# requires-python = ">=3.11"
# dependencies = ["tensorboard>=2.20"]
# ///
"""Export an archestra-bench run directory to TensorBoard scalar event files.

Reads `aggregate.json` (run-wide + per-lane stats) and the per-rollout `run.json` files, and writes
one scalar event file per CI run into stable per-run TensorBoard run dirs, so successive CI runs append
to the same scalar history. The `overall` run dir carries run-wide tags; each `lane=<lane>` run dir
carries per-(env, task) tags, so lanes line up as sibling series sharing task tags.

Pure read of the run dir → write event files under `--out`. Missing/null metrics are skipped, never
faked. The pod's `publish_run.py` uploads `--out` to GCS afterwards.
"""

import argparse
import json
import logging
import os
from pathlib import Path

from tensorboard.summary import Writer

logger = logging.getLogger(__name__)


def export(run_dir: Path, out_dir: Path, step: int) -> dict[str, int]:
    """Write event files for one run; returns the scalar count per TensorBoard run dir."""
    aggregate = json.loads((run_dir / "aggregate.json").read_text())
    rollouts = _load_rollouts(run_dir)

    counts: dict[str, int] = {}
    counts["overall"] = _write_overall(out_dir / "overall", aggregate, step)
    for lane, lane_aggregate in _per_lane(aggregate).items():
        lane_rollouts = [r for r in rollouts if r.get("lane") == lane]
        counts[f"lane={lane}"] = _write_lane(
            out_dir / f"lane={lane}", lane_aggregate, lane_rollouts, step
        )
    return counts


def default_step() -> int:
    """`GITHUB_RUN_NUMBER * 100 + GITHUB_RUN_ATTEMPT` — monotonic across re-runs of a run number."""
    run_number = int(os.environ.get("GITHUB_RUN_NUMBER", "0"))
    run_attempt = int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
    return run_number * 100 + run_attempt


def _load_rollouts(run_dir: Path) -> list[dict]:
    rollouts = []
    for path in sorted(run_dir.glob("**/run.json")):
        rollouts.append(json.loads(path.read_text()))
    return rollouts


def _per_lane(aggregate: dict) -> dict[str, dict]:
    return {g["lane"]: g for g in aggregate.get("per_lane", [])}


def _write_overall(out: Path, aggregate: dict, step: int) -> int:
    writer = Writer(str(out))
    n = 0
    n += _scalar(writer, "overall/pass_rate", aggregate.get("pass_rate"), step)
    n += _scalar(writer, "overall/passed", aggregate.get("passed"), step)
    n += _scalar(writer, "overall/total", aggregate.get("total"), step)
    n += _scalar(writer, "overall/avg_turns", aggregate.get("avg_turns"), step)
    n += _scalar(writer, "overall/avg_tokens", aggregate.get("avg_tokens"), step)
    n += _scalar(writer, "overall/cost_usd", aggregate.get("cost_usd"), step)
    for outcome, count in (aggregate.get("outcomes") or {}).items():
        n += _scalar(writer, f"outcomes/{outcome}", count, step)
    writer.close()
    return n


def _write_lane(out: Path, lane_aggregate: dict, rollouts: list[dict], step: int) -> int:
    writer = Writer(str(out))
    n = 0
    n += _scalar(writer, "pass_rate", lane_aggregate.get("pass_rate"), step)
    n += _scalar(writer, "passed", lane_aggregate.get("passed"), step)
    n += _scalar(writer, "total", lane_aggregate.get("total"), step)
    n += _scalar(writer, "cost_usd", lane_aggregate.get("cost_usd"), step)
    for rollout in rollouts:
        slot = f"{rollout['env_id']}/{rollout['task_id']}"
        outcome = rollout.get("outcome")
        n += _scalar(writer, f"pass/{slot}", 1.0 if outcome == "passed" else 0.0, step)
        n += _scalar(writer, f"turns/{slot}", rollout.get("turn_count"), step)
        n += _scalar(writer, f"tokens/{slot}", rollout.get("total_tokens"), step)
        n += _scalar(writer, f"cost/{slot}", rollout.get("cost_usd"), step)
        n += _scalar(writer, f"tool_calls/{slot}", rollout.get("tool_call_count"), step)
        if outcome is not None:
            n += _scalar(writer, f"outcome/{outcome}/{slot}", 1.0, step)
    writer.close()
    return n


def _scalar(writer: Writer, tag: str, value, step: int) -> int:
    if value is None:
        return 0
    writer.add_scalar(tag, float(value), step)
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True, help="Finished bench run directory")
    parser.add_argument("--out", type=Path, required=True, help="TensorBoard output root")
    parser.add_argument(
        "--step",
        type=int,
        default=None,
        help="Scalar step (default: GITHUB_RUN_NUMBER * 100 + GITHUB_RUN_ATTEMPT)",
    )
    args = parser.parse_args()
    step = args.step if args.step is not None else default_step()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    counts = export(args.run_dir, args.out, step)
    for run_name, count in counts.items():
        logger.info("%s: %d scalars at step %d", run_name, count, step)


if __name__ == "__main__":
    main()
