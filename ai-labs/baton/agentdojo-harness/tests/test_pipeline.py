"""Pipeline construction (no network)."""

import pytest
from agentdojo.agent_pipeline import ToolsExecutionLoop, ToolsExecutor

from baton_dojo.contracts import load_table
from baton_dojo.defense import BatonToolsExecutor
from baton_dojo.pipeline import build_pipeline

TABLE = load_table("workspace")


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-never-used")


def executor_of(pipeline):
    loop = next(e for e in pipeline.elements if isinstance(e, ToolsExecutionLoop))
    return loop.elements[0]


def test_baton_pipeline_shape():
    pipeline = build_pipeline("openai/gpt-4o-mini", TABLE, "baton", "allow_with_audit")
    assert pipeline.name == "openai_gpt-4o-mini-baton-allow_with_audit"
    assert isinstance(executor_of(pipeline), BatonToolsExecutor)


def test_none_pipeline_is_stock():
    pipeline = build_pipeline("openai/gpt-4o-mini", TABLE, "none", "allow_with_audit")
    assert pipeline.name == "openai_gpt-4o-mini-none"
    executor = executor_of(pipeline)
    assert type(executor) is ToolsExecutor


def test_unknown_defense_rejected():
    with pytest.raises(ValueError):
        build_pipeline("m", TABLE, "spotlight", "deny")
