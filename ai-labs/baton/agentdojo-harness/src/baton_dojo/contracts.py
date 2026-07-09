"""Load a suite's contract table and turn it into baton-check wire format."""

import tomllib
from dataclasses import dataclass
from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts"

_TRUST_VALUES = {"trusted", "suspicious", "unknown"}
_REQUIRES_TRUST_VALUES = {"trusted", "suspicious"}


@dataclass(frozen=True)
class ToolPolicy:
    tool: str
    output_trust: str
    requires_trust: str | None
    recipients_arg: str | None


@dataclass(frozen=True)
class ContractTable:
    suite: str
    tools: dict[str, ToolPolicy]

    def wire_contracts(self) -> list[dict]:
        """The `contracts` fragment of a baton-check request."""
        contracts = []
        for policy in self.tools.values():
            contract: dict = {"tool": policy.tool, "output": {"trust": policy.output_trust}}
            if policy.requires_trust is not None:
                contract["requires"] = {"trust": policy.requires_trust}
            contracts.append(contract)
        return contracts

    def recipients_of(self, tool: str, args: dict) -> list[str]:
        """Recipients a call would expose data to, per the table's mapping."""
        policy = self.tools.get(tool)
        if policy is None or policy.recipients_arg is None:
            return []
        value = args.get(policy.recipients_arg)
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            return list(value)
        raise ValueError(
            f"{tool}.{policy.recipients_arg} is not a string or list of strings: {value!r}"
        )

    def check_covers(self, suite_tool_names: set[str]) -> None:
        """Fail loudly when the table and the live suite disagree."""
        table_names = set(self.tools)
        missing = sorted(suite_tool_names - table_names)
        stale = sorted(table_names - suite_tool_names)
        if missing or stale:
            raise ValueError(
                f"contract table for `{self.suite}` is out of sync with the suite: "
                f"missing={missing} stale={stale}"
            )


def load_table(suite: str) -> ContractTable:
    path = CONTRACTS_DIR / f"{suite}.toml"
    if not path.exists():
        raise FileNotFoundError(f"no contract table for suite `{suite}` at {path}")
    with path.open("rb") as fh:
        raw = tomllib.load(fh)

    tools: dict[str, ToolPolicy] = {}
    for tool, entry in raw.get("tools", {}).items():
        unknown_keys = set(entry) - {"output_trust", "requires_trust", "recipients_arg"}
        if unknown_keys:
            raise ValueError(f"[tools.{tool}] has unknown keys: {sorted(unknown_keys)}")
        output_trust = entry["output_trust"]
        if output_trust not in _TRUST_VALUES:
            raise ValueError(f"[tools.{tool}] output_trust must be one of {_TRUST_VALUES}")
        requires_trust = entry.get("requires_trust")
        if requires_trust is not None and requires_trust not in _REQUIRES_TRUST_VALUES:
            raise ValueError(f"[tools.{tool}] requires_trust must be one of {_REQUIRES_TRUST_VALUES}")
        tools[tool] = ToolPolicy(
            tool=tool,
            output_trust=output_trust,
            requires_trust=requires_trust,
            recipients_arg=entry.get("recipients_arg"),
        )
    if not tools:
        raise ValueError(f"contract table {path} defines no tools")
    return ContractTable(suite=suite, tools=tools)
