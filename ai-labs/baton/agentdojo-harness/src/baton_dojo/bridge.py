"""Subprocess bridge to baton-check.

Stateless by design: every check ships the whole episode (user prompt +
executed calls) and baton-check rebuilds the trajectory from scratch, so no
permits or trajectories ever live across the process boundary.
"""

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

BATON_CHECK_DIR = Path(__file__).resolve().parents[3] / "baton-check"

UNKNOWN_POLICIES = ("deny", "allow_with_audit", "escalate")

_binary_cache: Path | None = None


class BatonProtocolError(RuntimeError):
    """baton-check rejected the request (exit 2): caller and baton-check disagree."""


@dataclass(frozen=True)
class Call:
    tool: str
    recipients: tuple[str, ...] = ()

    def wire(self) -> dict:
        return {"tool": self.tool, "recipients": list(self.recipients)}


@dataclass(frozen=True)
class BatonDecision:
    permitted: bool
    audited: bool = False
    block_kind: str | None = None
    detail: str = ""


def resolve_binary() -> Path:
    """`$BATON_CHECK_BIN` if set, else build the sibling crate once."""
    global _binary_cache
    if _binary_cache is not None:
        return _binary_cache
    import os

    override = os.environ.get("BATON_CHECK_BIN")
    if override:
        path = Path(override)
        if not path.is_file():
            raise FileNotFoundError(f"BATON_CHECK_BIN={override} does not exist")
        _binary_cache = path
        return path

    subprocess.run(
        ["cargo", "build", "--release", "--quiet"],
        cwd=BATON_CHECK_DIR,
        check=True,
    )
    path = BATON_CHECK_DIR / "target" / "release" / "baton-check"
    if not path.is_file():
        raise FileNotFoundError(f"cargo build succeeded but {path} is missing")
    _binary_cache = path
    return path


class BatonBridge:
    def __init__(
        self,
        contracts: list[dict],
        unknown_policy: str,
        taint_policy: str = "allow",
    ):
        if unknown_policy not in UNKNOWN_POLICIES:
            raise ValueError(f"unknown_policy must be one of {UNKNOWN_POLICIES}")
        self.contracts = contracts
        self.unknown_policy = unknown_policy
        self.taint_policy = taint_policy

    def check(self, user_prompt: str, executed: list[Call], proposed: Call) -> BatonDecision:
        request = {
            "unknown_policy": self.unknown_policy,
            "taint_policy": self.taint_policy,
            "contracts": self.contracts,
            "user_prompt": user_prompt,
            "executed": [call.wire() for call in executed],
            "proposed": proposed.wire(),
        }
        result = subprocess.run(
            [str(resolve_binary())],
            input=json.dumps(request),
            capture_output=True,
            text=True,
        )
        if result.returncode == 2:
            raise BatonProtocolError(json.loads(result.stdout)["error"])
        if result.returncode != 0:
            raise RuntimeError(
                f"baton-check exited {result.returncode}: {result.stderr.strip()}"
            )
        output = json.loads(result.stdout)
        if output["decision"] == "permitted":
            return BatonDecision(permitted=True, audited=output["audited"])
        return BatonDecision(
            permitted=False,
            block_kind=output["block_kind"],
            detail=output["detail"],
        )
