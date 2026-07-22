"""Grades the contract-billed rollup: the agent must pull both the seat inventory and the contract terms
from the acme_it MCP, then report the real billed monthly total -- not the per-seat list-price sum. The
billed total (per-seat vs flat-commit vs amortized-annual) is unforgeable without joining the two
tool outputs, so answer-match plus the presence of both tool calls proves the work was done."""

from bench_verifier import read_fixture_json, result, tool_calls


def _expected() -> int:
    answer = read_fixture_json("expected", "answer.json")
    return answer["total_billed_monthly_cents"]


def test_called_seats_and_contracts() -> None:
    invoked = [name for name, _ in tool_calls()]
    assert any(name.endswith("__list_seats") for name in invoked), (
        f"agent never pulled the seat inventory; invoked={invoked}"
    )
    assert any(name.endswith("__list_license_contracts") for name in invoked), (
        f"agent never pulled the contract terms, so it could not have billed correctly; invoked={invoked}"
    )


def test_billed_total_matches() -> None:
    submitted = result()["total_billed_monthly_cents"]
    expected = _expected()
    assert submitted == expected, f"got {submitted}, expected {expected}"
