"""BatonToolsExecutor: the stock ToolsExecutor with a baton gate per call.

Stateless on purpose: AgentDojo reuses one pipeline object across every
(user task x injection task) run, so the episode is re-derived from
`messages` on every query — nothing accumulates on the element.
"""

from ast import literal_eval
from collections.abc import Sequence

from agentdojo.agent_pipeline.tool_execution import (
    EMPTY_FUNCTION_NAME,
    ToolsExecutor,
    is_string_list,
    tool_result_to_str,
)
from agentdojo.functions_runtime import FunctionsRuntime
from agentdojo.types import (
    ChatMessage,
    ChatToolResultMessage,
    get_text_content_as_str,
    text_content_block_from_string,
)

from baton_dojo.bridge import BatonBridge, Call
from baton_dojo.contracts import ContractTable

POLICY_BLOCK_SENTINEL = "Blocked by baton policy: "

# agentdojo appends these error messages *instead of* calling
# runtime.run_function, so calls carrying them never touched the environment.
# Exact strings from agentdojo==0.1.35 (locked by a test); every other error
# comes back from run_function, which may have executed side effects before
# failing — those calls count as executed (over-tainting is the fail-closed
# direction; under-counting would launder taint).
EMPTY_FUNCTION_NAME_ERROR = "Empty function name provided. Provide a valid function name."
INVALID_TOOL_ERROR_PREFIX = "Invalid tool "


def derive_episode(
    messages: Sequence[ChatMessage], table: ContractTable
) -> tuple[str, list[Call]]:
    """(user prompt, executed calls) as baton must see them, from messages alone."""
    user_prompt = None
    for message in messages:
        if message["role"] == "user":
            user_prompt = get_text_content_as_str(message["content"])
            break
    if user_prompt is None:
        raise ValueError("no user message in the conversation; nothing to gate against")

    executed = []
    for message in messages:
        if message["role"] != "tool":
            continue
        error = message["error"]
        if error is not None and (
            error.startswith(POLICY_BLOCK_SENTINEL)
            or error == EMPTY_FUNCTION_NAME_ERROR
            or error.startswith(INVALID_TOOL_ERROR_PREFIX)
        ):
            continue
        call = message["tool_call"]
        executed.append(
            Call(
                tool=call.function,
                recipients=tuple(table.recipients_of(call.function, dict(call.args))),
            )
        )
    return user_prompt, executed


class BatonToolsExecutor(ToolsExecutor):
    """Executes tool calls the LLM emitted, unless baton blocks them.

    Blocked calls are not executed; the LLM sees the same error channel
    agentdojo uses for its own tool failures, prefixed with
    POLICY_BLOCK_SENTINEL so episode derivation can tell them apart.
    """

    def __init__(
        self,
        table: ContractTable,
        unknown_policy: str,
        taint_policy: str = "allow",
        tool_output_formatter=tool_result_to_str,
    ) -> None:
        super().__init__(tool_output_formatter)
        self.table = table
        self.bridge = BatonBridge(
            contracts=table.wire_contracts(),
            unknown_policy=unknown_policy,
            taint_policy=taint_policy,
        )

    def query(
        self,
        query: str,
        runtime: FunctionsRuntime,
        env=None,
        messages: Sequence[ChatMessage] = [],
        extra_args: dict = {},
    ):
        if len(messages) == 0:
            return query, runtime, env, messages, extra_args
        if messages[-1]["role"] != "assistant":
            return query, runtime, env, messages, extra_args
        if messages[-1]["tool_calls"] is None or len(messages[-1]["tool_calls"]) == 0:
            return query, runtime, env, messages, extra_args

        user_prompt, executed = derive_episode(messages, self.table)

        tool_call_results = []
        for tool_call in messages[-1]["tool_calls"]:
            # Never-executed shapes, exactly as stock ToolsExecutor emits them.
            if tool_call.function == EMPTY_FUNCTION_NAME:
                tool_call_results.append(
                    ChatToolResultMessage(
                        role="tool",
                        content=[text_content_block_from_string("")],
                        tool_call_id=tool_call.id,
                        tool_call=tool_call,
                        error=EMPTY_FUNCTION_NAME_ERROR,
                    )
                )
                continue
            if tool_call.function not in (tool.name for tool in runtime.functions.values()):
                tool_call_results.append(
                    ChatToolResultMessage(
                        role="tool",
                        content=[text_content_block_from_string("")],
                        tool_call_id=tool_call.id,
                        tool_call=tool_call,
                        error=f"{INVALID_TOOL_ERROR_PREFIX}{tool_call.function} provided.",
                    )
                )
                continue

            # Stock arg coercion, before recipients extraction so baton sees
            # real lists rather than their string representations.
            for arg_k, arg_v in tool_call.args.items():
                if isinstance(arg_v, str) and is_string_list(arg_v):
                    tool_call.args[arg_k] = literal_eval(arg_v)

            proposed = Call(
                tool=tool_call.function,
                recipients=tuple(
                    self.table.recipients_of(tool_call.function, dict(tool_call.args))
                ),
            )
            decision = self.bridge.check(user_prompt, executed, proposed)
            if not decision.permitted:
                tool_call_results.append(
                    ChatToolResultMessage(
                        role="tool",
                        content=[text_content_block_from_string("")],
                        tool_call_id=tool_call.id,
                        tool_call=tool_call,
                        error=f"{POLICY_BLOCK_SENTINEL}{decision.detail}",
                    )
                )
                continue

            tool_call_result, error = runtime.run_function(
                env, tool_call.function, tool_call.args
            )
            # run_function may have executed side effects before erroring, so
            # the call joins the episode either way — mirroring derive_episode.
            executed.append(proposed)
            tool_call_results.append(
                ChatToolResultMessage(
                    role="tool",
                    content=[text_content_block_from_string(self.output_formatter(tool_call_result))],
                    tool_call_id=tool_call.id,
                    tool_call=tool_call,
                    error=error,
                )
            )
        return query, runtime, env, [*messages, *tool_call_results], extra_args
