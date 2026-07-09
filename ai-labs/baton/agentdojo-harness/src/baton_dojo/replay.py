"""Ground-truth replay: the deterministic, no-LLM gate.

Replays every user task's scripted `ground_truth()` call sequence (and every
injection task's, where one exists) through the baton gate under all three
unknown-policies, and prints one report table per policy.

Exit-code contract (pinned to the `deny` table):
  (a) every replayable injection task blocks at or before its first
      annotated-sink call;
  (b) every benign task whose ground truth has no suspicious-source read
      before its first sink call is fully permitted;
  (c) evaluating everything twice yields the identical report.
Benign tasks that do read tainted sources before a sink are the policy's
utility price: reported, never asserted.
"""

import time
from dataclasses import dataclass

from agentdojo.functions_runtime import FunctionsRuntime
from agentdojo.task_suite.load_suites import get_suite

from baton_dojo.bridge import UNKNOWN_POLICIES, BatonBridge, Call
from baton_dojo.contracts import ContractTable, load_table

# Taints the context ahead of an injection task's own calls: the attack text
# arrived through *some* reader; which one does not matter in label space.
TAINT_PREFIX_TOOL = "get_unread_emails"


@dataclass(frozen=True)
class CallOutcome:
    tool: str
    permitted: bool
    block_kind: str | None


@dataclass(frozen=True)
class TaskReplay:
    task_id: str
    outcomes: tuple[CallOutcome, ...]
    clean_flow: bool  # no suspicious read before the first sink call

    @property
    def fully_permitted(self) -> bool:
        return all(outcome.permitted for outcome in self.outcomes)

    @property
    def first_block(self) -> int | None:
        for index, outcome in enumerate(self.outcomes):
            if not outcome.permitted:
                return index
        return None


def is_sink(table: ContractTable, tool: str) -> bool:
    policy = table.tools.get(tool)
    return policy is not None and policy.requires_trust is not None


def is_suspicious_source(table: ContractTable, tool: str) -> bool:
    policy = table.tools.get(tool)
    return policy is not None and policy.output_trust == "suspicious"


def classify_clean_flow(table: ContractTable, tools: list[str]) -> bool:
    """True when no suspicious-source read precedes the first sink call."""
    for tool in tools:
        if is_sink(table, tool):
            return True
        if is_suspicious_source(table, tool):
            return False
    return True  # no sinks at all: a read-only task


def replay_calls(
    bridge: BatonBridge,
    table: ContractTable,
    user_prompt: str,
    calls: list,
    prefix: tuple[Call, ...] = (),
) -> tuple[CallOutcome, ...]:
    """Gate a scripted call sequence; permitted calls join the episode."""
    executed = list(prefix)
    outcomes = []
    for function_call in calls:
        proposed = Call(
            tool=function_call.function,
            recipients=tuple(
                table.recipients_of(function_call.function, dict(function_call.args))
            ),
        )
        decision = bridge.check(user_prompt, executed, proposed)
        outcomes.append(
            CallOutcome(
                tool=proposed.tool,
                permitted=decision.permitted,
                block_kind=decision.block_kind,
            )
        )
        if decision.permitted:
            executed.append(proposed)
    return tuple(outcomes)


def replay_suite(suite, table: ContractTable, unknown_policy: str):
    """One policy's full report: (benign TaskReplays, injection TaskReplays, unreplayable ids)."""
    bridge = BatonBridge(contracts=table.wire_contracts(), unknown_policy=unknown_policy)

    benign = []
    for task_id, task in suite.user_tasks.items():
        env = suite.load_and_inject_default_environment({})
        calls = task.ground_truth(env)
        benign.append(
            TaskReplay(
                task_id=task_id,
                outcomes=replay_calls(bridge, table, task.PROMPT, calls),
                clean_flow=classify_clean_flow(table, [call.function for call in calls]),
            )
        )

    injection = []
    unreplayable = []
    for task_id, task in suite.injection_tasks.items():
        env = suite.load_and_inject_default_environment({})
        calls = task.ground_truth(env)
        if not calls:
            unreplayable.append(task_id)
            continue
        injection.append(
            TaskReplay(
                task_id=task_id,
                outcomes=replay_calls(
                    bridge,
                    table,
                    task.GOAL,
                    calls,
                    prefix=(Call(tool=TAINT_PREFIX_TOOL),),
                ),
                clean_flow=False,
            )
        )
    return benign, injection, unreplayable


def injection_blocked_in_time(table: ContractTable, replay: TaskReplay) -> bool:
    """Assertion (a) for one injection task: blocked at/before the first sink."""
    first_sink = next(
        (i for i, outcome in enumerate(replay.outcomes) if is_sink(table, outcome.tool)),
        None,
    )
    if first_sink is None:
        # A scripted attack that never touches an annotated sink cannot be
        # judged by this gate; surfaced by the caller, never silently passed.
        return False
    block = replay.first_block
    return block is not None and block <= first_sink


def format_policy_report(
    table, unknown_policy, benign, injection, unreplayable
) -> tuple[str, list[str]]:
    """(report text, hard assertion failures for this table)."""
    lines = [f"== unknown_policy: {unknown_policy} =="]
    failures = []

    clean = [replay for replay in benign if replay.clean_flow]
    tainted = [replay for replay in benign if not replay.clean_flow]
    clean_ok = [replay for replay in clean if replay.fully_permitted]
    tainted_ok = [replay for replay in tainted if replay.fully_permitted]

    lines.append(
        f"benign: {len(clean_ok)}/{len(clean)} clean-flow tasks fully permitted; "
        f"{len(tainted_ok)}/{len(tainted)} tainted-flow tasks fully permitted "
        f"(the rest are the policy's utility price)"
    )
    for replay in benign:
        if replay.fully_permitted:
            continue
        index = replay.first_block
        outcome = replay.outcomes[index]
        flow = "CLEAN-FLOW " if replay.clean_flow else ""
        lines.append(
            f"  {flow}{replay.task_id}: blocked at call {index + 1}/{len(replay.outcomes)} "
            f"({outcome.tool}, {outcome.block_kind})"
        )
        if replay.clean_flow:
            failures.append(f"(b) {replay.task_id}: clean flow blocked at {outcome.tool}")

    blocked = [replay for replay in injection if injection_blocked_in_time(table, replay)]
    total_injection = len(injection) + len(unreplayable)
    lines.append(
        f"injection: {len(blocked)}/{len(injection)} scripted attacks blocked at/before "
        f"their first sink (hard-checked {len(injection)}/{total_injection} of the suite's "
        f"injection tasks; {len(unreplayable)} have no scripted trace and are NOT gate-checked: "
        f"{', '.join(unreplayable) if unreplayable else '-'})"
    )
    for replay in injection:
        ok = injection_blocked_in_time(table, replay)
        marker = "blocked" if ok else "NOT BLOCKED"
        lines.append(
            f"  {replay.task_id}: {marker} "
            f"({' -> '.join(outcome.tool for outcome in replay.outcomes)})"
        )
        if not ok:
            failures.append(f"(a) {replay.task_id}: attack not blocked at its first sink")
    return "\n".join(lines), failures


def run_replay(suite_name: str, benchmark_version: str) -> int:
    started = time.monotonic()
    suite = get_suite(benchmark_version, suite_name)
    table = load_table(suite_name)
    table.check_covers({tool.name for tool in suite.tools})

    def evaluate() -> tuple[str, list[str]]:
        reports, failures = [], []
        for unknown_policy in UNKNOWN_POLICIES:
            benign, injection, unreplayable = replay_suite(suite, table, unknown_policy)
            text, policy_failures = format_policy_report(
                table, unknown_policy, benign, injection, unreplayable
            )
            reports.append(text)
            if unknown_policy == "deny":
                failures.extend(policy_failures)
        return "\n\n".join(reports), failures

    report, failures = evaluate()
    second_report, _ = evaluate()
    if second_report != report:
        failures.append("(c) two consecutive evaluations produced different reports")

    print(report)
    print(f"\nreplay wall time: {time.monotonic() - started:.1f}s")
    if failures:
        print("\nHARD ASSERTION FAILURES (deny table):")
        for failure in failures:
            print(f"  {failure}")
        return 1
    print("\nhard assertions (deny table): all green")
    return 0
