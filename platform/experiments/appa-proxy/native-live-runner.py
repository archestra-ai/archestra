#!/usr/bin/env python3
"""Run one sequential, native Archestra APPA fixture case.

This script never starts a relay. Provider traffic is configured directly to an
Archestra native proxy on port 9002. Runtime evidence is collected only through
an explicitly supplied, deployment-owned read-only command.
"""

from __future__ import annotations

import argparse
import datetime as dt
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import time
from types import SimpleNamespace
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4


ROOT = Path(__file__).resolve().parent
SCENARIOS_PATH = ROOT / "native-live-scenarios.json"
FORBIDDEN_RELAY_PORTS = set(range(18700, 18800))
MAX_CAPTURE_BYTES = 2 * 1024 * 1024
STOCK_CLIENT_VERSIONS = {
    "claude": "2.1.258",
    "codex": "0.153.0",
    "opencode": "1.18.29",
}
PIPELINE_VERSION = "native-live-harness/v2"
SOURCE_ARCHIVE_VERSION = 2
SOURCE_ARCHIVE_FILES = {
    "invoked_runner": ROOT / "native-live-runner.py",
    "phase_parser": ROOT / "backend-phase-trace-reader.py",
    "collector": ROOT / "native-live-collector.py",
    "assertion": ROOT / "native-live-assert.py",
    "scenarios": ROOT / "native-live-scenarios.json",
    "phase_reader_wrapper": ROOT / "backend-phase-trace-reader.sh",
}
GATEWAY_CONTROL_METHODS = (
    "archestra__appa_execute_remedy",
    "archestra__appa_inspect_plan",
    "archestra__appa_status",
    "archestra__run_tool",
    "archestra__search_tools",
)


def main() -> int:
    args = parse_args()
    if args.verify_source_archive:
        verify_source_archive(args.verify_source_archive)
        print(json.dumps({"source_archive": "verified"}, sort_keys=True))
        return 0
    if args.provision_stock_provenance:
        return provision_stock_provenance(args)
    required_options = ("agent_id", "evidence_dir", "proxy_url", "expected_proxy_url", "runtime_service_url", "runtime_transport_url")
    if any(getattr(args, name) is None for name in required_options):
        raise SystemExit("--agent-id, --evidence-dir, --proxy-url, --expected-proxy-url, --runtime-service-url, and --runtime-transport-url are required")
    if not args.client or not args.scenario:
        raise SystemExit("--client and --scenario are required unless --provision-stock-provenance is used")
    scenarios = load_scenarios(args.scenarios)
    scenario = next((item for item in scenarios["scenarios"] if item["id"] == args.scenario), None)
    if scenario is None:
        raise SystemExit(f"unknown scenario: {args.scenario}")
    validate_scenario_contract(scenario)
    if args.client not in scenario["clients"]:
        raise SystemExit(f"scenario {args.scenario} is not supported for {args.client}")

    validate_proxy_endpoint(args.proxy_url, args.expected_proxy_url)
    runtime_transport_kind = validate_runtime_endpoints(
        args.runtime_service_url,
        args.runtime_transport_url,
        args.allow_dev_loopback_runtime_transport,
        args.runtime_profile,
    )
    validate_agent_id(args.agent_id)
    evidence_root = prepare_evidence_root(args.evidence_dir)
    run_id = args.run_id or f"run-{utc_stamp().lower()}-{secrets.token_hex(8)}"
    if not re.fullmatch(r"run-[a-z0-9-]{8,96}", run_id):
        raise SystemExit("--run-id has an invalid format")
    run_dir = evidence_root / args.client / args.scenario / run_id
    run_dir.mkdir(mode=0o700, parents=True)
    os.chmod(run_dir, 0o700)
    request_key = f"synthetic-{args.scenario.replace('-', '_')}-{secrets.token_hex(12)}"
    provider_base = provider_base_url(args.proxy_url, args.agent_id, args.client)
    plan = {
        "version": 2,
        "status": "planned" if args.offline else "prepared",
        "evidence_mode": args.evidence_mode,
        "run_id": run_id,
        "client": args.client,
        "scenario": args.scenario,
        "request_key": request_key,
        "direct_route": {
            "provider_base_url": provider_base,
            "configured_proxy_url": args.proxy_url.rstrip("/"),
            "expected_proxy_url": args.expected_proxy_url.rstrip("/"),
            "relay_ports": [],
        },
        "runtime": {
            "logical_service_url": args.runtime_service_url.rstrip("/"),
            "backend_transport_url": args.runtime_transport_url.rstrip("/"),
            "backend_transport_kind": runtime_transport_kind,
        },
        "fixture": {"url": args.fixture_url, "transport": "streamable-http"} if args.fixture_url else None,
        "expected_exit": scenario["expected_exit"],
        "compaction_mechanism": compaction_mechanism(args.client) if args.scenario.startswith("compact-") else None,
        "qualification": {
            "eligible": False,
            "reason": "offline plans never establish live readiness" if args.offline else "live provenance has not been verified",
        },
    }
    write_json(run_dir / "plan.json", plan)
    if args.offline:
        print(json.dumps({"status": "planned", "run_id": run_id, "case": args.scenario, "proxy_url": args.proxy_url.rstrip("/")}))
        return 0

    require_live_inputs(args)
    require_session_prerequisite(args)
    if not args.execute:
        raise SystemExit("refusing provider execution without --execute; use --offline to validate wiring")
    if os.environ.get("APPA_NATIVE_LIVE_DEPLOYED_READY") != "1":
        raise SystemExit("refusing provider execution until APPA_NATIVE_LIVE_DEPLOYED_READY=1")
    client_identity = verify_client_identity(args)
    gateway = read_gateway_profile(args.gateway_profile) if args.evidence_mode == "qualifying" else None
    gateway_control_inventory = verify_gateway_control_inventory(gateway, args.gateway_token_file) if gateway else None
    runtime_trace_observer = verify_runtime_trace_observer(args)
    plan["client_provenance"] = client_identity
    plan["runtime_trace_observer"] = runtime_trace_observer
    plan["gateway"] = gateway_public_identity(gateway)
    plan["gateway_control_inventory"] = gateway_control_inventory
    plan["configuration"] = configuration_fingerprint(args, provider_base, gateway=gateway)
    plan["qualification"] = {
        "eligible": args.evidence_mode == "qualifying",
        "reason": "awaiting backend and fixture evidence" if args.evidence_mode == "qualifying" else "explicit nonqualifying diagnostic mode",
    }
    write_json(run_dir / "plan.json", plan)
    write_json(run_dir / "client-provenance.json", client_identity)

    create_fixture_run(args.fixture_url, required_env("APPA_NATIVE_FIXTURE_ADMIN_TOKEN"), run_id)
    # The observer is scoped to a fixture run. This authenticated read occurs
    # after inert run creation but before the client can initiate provider work.
    fixture_observer = verify_fixture_observer(args, run_id)
    plan["fixture_observer"] = fixture_observer
    write_json(run_dir / "plan.json", plan)
    fixture_before = fixture_summary(args.fixture_url, required_env("APPA_NATIVE_FIXTURE_ADMIN_TOKEN"), run_id)
    write_json(run_dir / "fixture-before.json", fixture_before)
    prompt = scenario_prompt(scenario["prompt"], request_key, run_id, gateway)
    command, env, transient_paths = client_command(args, provider_base, prompt, run_dir, client_identity["resolved_path"], gateway)
    # The launch record is finalized before the process starts. It retains an
    # exact argv fingerprint, not prompts, secret values, or private config.
    plan["configuration"] = configuration_fingerprint(args, provider_base, command, gateway)
    plan["harness_attestation"] = archive_harness_attestation(
        run_dir,
        client_identity,
        plan["configuration"],
        gateway_control_inventory,
    )
    write_json(run_dir / "plan.json", plan)
    started = time.monotonic()
    try:
        compaction = run_compaction_phase(args, command, env, run_dir, scenarios["fixtures"]["private_marker"])
        exit_code, stdout, stderr, reviewer = run_process(
            command,
            env,
            args.timeout,
            args.reviewer_command if args.scenario.startswith("test-review-") else None,
            run_dir,
            args.scenario,
            args.client,
            request_key,
        )
    finally:
        for path in transient_paths:
            path.unlink(missing_ok=True)
    verify_client_identity_stable(client_identity)
    sanitized_stdout = sanitize(stdout, scenarios["fixtures"]["private_marker"])
    sanitized_stderr = sanitize(stderr, scenarios["fixtures"]["private_marker"])
    write_text(run_dir / "client.stdout.log", sanitized_stdout)
    write_text(run_dir / "client.stderr.log", sanitized_stderr)
    fixture_after = fixture_summary(args.fixture_url, required_env("APPA_NATIVE_FIXTURE_ADMIN_TOKEN"), run_id)
    write_json(run_dir / "fixture-after.json", fixture_after)
    # Client stdout is untrusted and is deliberately not used as the evidence
    # selector. The collector discovers the single owner-bound backend session
    # from the run-scoped, canonical APPA call instead.
    fixture_evidence = collect_fixture_evidence(args, run_dir, run_id, request_key, scenarios["fixtures"])
    runtime_evidence = collect_runtime_evidence(args, run_dir, run_id, request_key, reviewer, scenarios["fixtures"])
    # The reader drains the deployment-owned capture through the last scoped
    # socket-write before this immutable per-run snapshot is taken.
    archive_phase_trace(run_dir)
    result = {
        **plan,
        "status": "completed",
        "exit_code": exit_code,
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "command": redact_command(command),
        "fixture_before": fixture_before,
        "fixture_after": fixture_after,
        "runtime_evidence": runtime_evidence,
        "fixture_evidence": fixture_evidence,
        "compaction": compaction,
        "reviewer": redact_reviewer(reviewer),
        "captures": {
            "stdout_bytes": len(sanitized_stdout.encode()),
            "stderr_bytes": len(sanitized_stderr.encode()),
            "private_source_redacted": all(marker not in sanitized_stdout + sanitized_stderr for marker in (scenarios["fixtures"]["private_marker"], "synthetic.person@example.test")),
        },
    }
    write_json(run_dir / "result.json", result)
    print(json.dumps({"status": "completed", "run_id": run_id, "case": args.scenario, "exit_code": exit_code, "proxy_url": args.proxy_url.rstrip("/")}))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one native APPA live fixture case without a relay")
    parser.add_argument("--client", choices=["claude", "codex", "opencode"])
    parser.add_argument("--scenario")
    parser.add_argument("--run-id", help="launcher-provided unique ID used to isolate backend phase capture")
    parser.add_argument("--provision-stock-provenance", action="store_true", help="create an explicit stock-client provenance manifest from PATH")
    parser.add_argument("--verify-source-archive", type=Path)
    parser.add_argument("--agent-id")
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument("--proxy-url", help="direct Archestra native proxy URL for this deployment")
    parser.add_argument("--expected-proxy-url", help="expected direct proxy URL; must exactly match --proxy-url")
    parser.add_argument("--runtime-service-url", help="logical HTTP .svc.cluster.local APPA runtime identity")
    parser.add_argument("--runtime-transport-url", help="actual backend hook transport URL")
    parser.add_argument("--runtime-profile", help="attested isolated runtime profile for a non-service loopback port")
    parser.add_argument("--allow-dev-loopback-runtime-transport", action="store_true", help="explicit development-only opt-in for a 127.0.0.1 kubectl port-forward")
    parser.add_argument("--fixture-url", help="native fixture base URL; required for live execution")
    parser.add_argument("--client-bin", help="diagnostic client launcher path")
    parser.add_argument("--stock-client-bin", type=Path, help="explicit qualifying stock launcher; otherwise resolve the client from PATH")
    parser.add_argument("--stock-provenance", type=Path, help="mode-0600 qualifying stock-client provenance manifest")
    parser.add_argument("--gateway-profile", type=Path, help="mode-0600 registry-derived gateway profile required for qualifying execution")
    parser.add_argument("--gateway-token-file", type=Path, help="mode-0600 KEY=value token reference; never shell-sourced")
    parser.add_argument("--evidence-mode", choices=["qualifying", "diagnostic"], default="qualifying", help="qualifying mode is the only mode eligible for readiness")
    parser.add_argument("--fixture-evidence-command", help="trusted read-only fixture audit observer required for qualifying execution")
    parser.add_argument("--runtime-evidence-command", help="read-only command returning a sanitized JSON evidence object")
    parser.add_argument("--reviewer-command", help="automated TEST reviewer command for review scenarios")
    parser.add_argument("--test-reviewer-id-sha256", help="SHA-256 of the authorized automated TEST reviewer identity")
    parser.add_argument("--resume-session", help="native session/thread ID for a fork or post-compaction follow-up")
    parser.add_argument("--timeout", type=positive_int, default=300)
    parser.add_argument("--execute", action="store_true", help="allow a provider call after deployed-ready acknowledgement")
    parser.add_argument("--offline", action="store_true", help="validate the plan only; performs no network or provider calls")
    parser.add_argument("--scenarios", type=Path, default=SCENARIOS_PATH)
    args = parser.parse_args()
    if args.execute and args.offline:
        parser.error("--execute and --offline are mutually exclusive")
    return args


def load_scenarios(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("version") != 1 or not isinstance(data.get("scenarios"), list):
        raise SystemExit("invalid native live scenario matrix")
    return data


def validate_scenario_contract(scenario: dict[str, Any]) -> None:
    """Keep the native Agent exercise narrow instead of widening all runs."""
    scenario_id = scenario.get("id")
    clients = scenario.get("clients")
    if not isinstance(scenario_id, str) or not isinstance(clients, list):
        raise SystemExit("invalid native live scenario contract")
    if scenario_id.startswith("child-") and clients != ["claude"]:
        raise SystemExit("native child scenarios are Claude-only")


def require_live_inputs(args: argparse.Namespace) -> None:
    if not args.fixture_url:
        raise SystemExit("--fixture-url is required for live execution")
    required_env("APPA_NATIVE_LIVE_ANTHROPIC_API_KEY")
    required_env("APPA_NATIVE_LIVE_OPENAI_API_KEY")
    required_env("APPA_NATIVE_LIVE_KIMI_API_KEY")
    required_env("APPA_NATIVE_FIXTURE_ADMIN_TOKEN")
    if args.evidence_mode == "diagnostic":
        required_env("APPA_NATIVE_FIXTURE_TOKEN")
    else:
        if args.stock_provenance is None:
            raise SystemExit("qualifying execution requires --stock-provenance")
        if args.gateway_profile is None:
            raise SystemExit("qualifying execution requires --gateway-profile")
    if args.scenario.startswith("test-review-") and (not args.reviewer_command or not args.test_reviewer_id_sha256 or not re.fullmatch(r"[0-9a-f]{64}", args.test_reviewer_id_sha256)):
        raise SystemExit("test-review scenarios require --reviewer-command and --test-reviewer-id-sha256 for automated-test-reviewer only")


def require_session_prerequisite(args: argparse.Namespace) -> None:
    if args.scenario.startswith(("fork-", "compact-")) and not args.resume_session:
        raise SystemExit(f"{args.scenario} requires --resume-session from an earlier native source run")
    if args.scenario.startswith("compact-") and args.client == "opencode":
        raise SystemExit("OpenCode 1.18.29 exposes no explicit compaction command; do not claim a compacted run until its stock client exposes a non-model compaction control")


def validate_proxy_endpoint(value: str, expected_value: str) -> None:
    from urllib.parse import urlparse

    parsed = urlparse(value)
    expected = urlparse(expected_value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise SystemExit("native proxy must be an HTTP(S) URL without embedded credentials")
    if value.rstrip("/") != expected_value.rstrip("/"):
        raise SystemExit("--proxy-url must exactly match --expected-proxy-url")
    if parsed.port in FORBIDDEN_RELAY_PORTS or "relay" in parsed.path.lower():
        raise SystemExit("relay routing is forbidden")
    if expected.port in FORBIDDEN_RELAY_PORTS or "relay" in expected.path.lower():
        raise SystemExit("expected native proxy must not reference a relay")


def validate_runtime_endpoints(logical_url: str, transport_url: str, allow_dev_loopback: bool, runtime_profile: str | None) -> str:
    from urllib.parse import urlparse

    logical = urlparse(logical_url)
    transport = urlparse(transport_url)
    if logical.scheme != "http" or not logical.hostname or not logical.hostname.endswith(".svc.cluster.local"):
        raise SystemExit("--runtime-service-url must be an HTTP cluster-local .svc.cluster.local URL")
    if transport_url.rstrip("/") == logical_url.rstrip("/"):
        return "cluster-dns"
    if not allow_dev_loopback:
        raise SystemExit("backend transport must equal the logical runtime service unless --allow-dev-loopback-runtime-transport is explicit")
    if transport.scheme != "http" or transport.hostname != "127.0.0.1":
        raise SystemExit("development runtime transport must be literal http://127.0.0.1 with the logical service port")
    if transport.port != logical.port:
        if not runtime_profile:
            raise SystemExit("a non-service loopback runtime port requires an attested runtime profile")
        try:
            profile = json.loads(Path(runtime_profile).read_text())
            inventory = json.loads((Path(runtime_profile).parent / "inventory.json").read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit("runtime profile attestation is unavailable") from error
        if (
            profile.get("runtimeUrl") != transport_url
            or inventory.get("backendHookUrl") != transport_url
            or inventory.get("runtimeForward", {}).get("listener") != f"127.0.0.1:{transport.port}"
            or inventory.get("service") != logical.netloc
        ):
            raise SystemExit("runtime profile does not attest the requested loopback transport")
    return "dev-loopback-port-forward"


def validate_agent_id(value: str) -> None:
    try:
        UUID(value)
    except ValueError as error:
        raise SystemExit("--agent-id must be a UUID") from error


def prepare_evidence_root(root: Path) -> Path:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def provider_base_url(proxy_url: str, agent_id: str, client: str) -> str:
    base = proxy_url.rstrip("/")
    if client == "claude":
        return f"{base}/v1/anthropic/{agent_id}"
    if client == "opencode":
        return f"{base}/v1/kimi/{agent_id}"
    return f"{base}/v1/openai/{agent_id}"


def client_command(args: argparse.Namespace, base_url: str, prompt: str, run_dir: Path, executable: str, gateway: dict[str, Any] | None) -> tuple[list[str], dict[str, str], list[Path]]:
    home = run_dir / "client-home"
    home.mkdir(mode=0o700)
    os.chmod(home, 0o700)
    if gateway:
        mcp_url = str(gateway["url"])
        mcp_token_env = str(gateway["token_env"])
        mcp_token = gateway_token(mcp_token_env, getattr(args, "gateway_token_file", None))
        mcp_key = str(gateway["client_server_key"])
    else:
        mcp_url = f"{args.fixture_url.rstrip('/')}/mcp"
        mcp_token_env = "APPA_NATIVE_FIXTURE_TOKEN"
        mcp_token = required_env(mcp_token_env)
        mcp_key = "appa_fixture"
    env = {key: os.environ[key] for key in ("LANG", "PATH", "NODE_USE_SYSTEM_CA") if key in os.environ}
    env.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"), "XDG_CACHE_HOME": str(home / ".cache"), "XDG_DATA_HOME": str(home / ".local/share"), "TERM": "dumb", mcp_token_env: mcp_token})
    transient: list[Path] = []
    if args.client == "claude":
        config_path = run_dir / "claude-mcp.json"
        write_private_json(config_path, {"mcpServers": {mcp_key: {"type": "http", "url": mcp_url, "headers": {"Authorization": f"Bearer {mcp_token}"}}}})
        transient.append(config_path)
        env.update({"ANTHROPIC_API_KEY": required_env("APPA_NATIVE_LIVE_ANTHROPIC_API_KEY"), "ANTHROPIC_BASE_URL": base_url, "CLAUDE_CONFIG_DIR": str(home / ".claude"), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
        claude_tools = claude_allowed_tools(args, gateway, mcp_key)
        gateway_tool_options = ["--tools", *claude_tools, "--allowedTools", *claude_tools]
        command = [str(executable), "--strict-mcp-config", "--mcp-config", str(config_path), "--setting-sources", "", *gateway_tool_options, "--model", "claude-haiku-4-5", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--session-id", str(uuid4())]
        if args.resume_session:
            command.extend(["--resume", args.resume_session])
        if args.scenario.startswith("fork-"):
            command.append("--fork-session")
        command.extend(["-p", prompt])
    elif args.client == "codex":
        codex_home = home / ".codex"
        codex_home.mkdir(mode=0o700)
        os.chmod(codex_home, 0o700)
        env.update({"OPENAI_API_KEY": required_env("APPA_NATIVE_LIVE_OPENAI_API_KEY"), "CODEX_HOME": str(codex_home)})
        command = [str(executable), "--ask-for-approval", "never", "exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "-m", "gpt-5.4", "-c", 'model_provider="archestra"', "-c", 'model_providers.archestra.name="Archestra native"', "-c", f'model_providers.archestra.base_url="{base_url}"', "-c", 'model_providers.archestra.env_key="OPENAI_API_KEY"', "-c", 'model_providers.archestra.wire_api="responses"', "-c", 'model_providers.archestra.supports_websockets=false', "-c", 'model_reasoning_effort="low"', "-c", "features.multi_agent=true", "-c", "features.multi_agent_v2=false", "-c", f'mcp_servers.{mcp_key}.url="{mcp_url}"', "-c", f'mcp_servers.{mcp_key}.bearer_token_env_var="{mcp_token_env}"']
        if gateway:
            command.extend(
                [
                    "-c",
                    f"mcp_servers.{mcp_key}.enabled_tools={json.dumps(GATEWAY_CONTROL_METHODS)}",
                ]
            )
            for tool in GATEWAY_CONTROL_METHODS:
                command.extend(
                    [
                        "-c",
                        f'mcp_servers.{mcp_key}.tools.{tool}.approval_mode="approve"',
                    ]
                )
        if args.scenario.startswith("compact-"):
            command.extend(["-c", "model_auto_compact_token_limit=500"])
        if args.resume_session:
            command.extend(["fork" if args.scenario.startswith("fork-") else "resume", args.resume_session])
        command.append(prompt)
    else:
        config_path = run_dir / "opencode.json"
        # OpenCode derives native IDs as <registration_key>_<tool_name>, not
        # Claude Code's mcp__<registration_key>__<tool_name> wire spelling.
        allowed_mcp_tools = (
            GATEWAY_CONTROL_METHODS
            if gateway
            else ("read_source", "publish", "protected_publish")
        )
        permission = {
            "*": "deny",
            "task": "allow",
            **{f"{mcp_key}_{tool}": "allow" for tool in allowed_mcp_tools},
        }
        write_private_json(config_path, {"$schema": "https://opencode.ai/config.json", "share": "disabled", "enabled_providers": ["archestra-native"], "model": "archestra-native/kimi-for-coding", "provider": {"archestra-native": {"npm": "@ai-sdk/openai-compatible", "name": "Archestra native", "models": {"kimi-for-coding": {"name": "Kimi for Coding", "tool_call": True, "limit": {"context": 262144, "output": 16384}}}, "options": {"baseURL": base_url, "apiKey": required_env("APPA_NATIVE_LIVE_KIMI_API_KEY")}}}, "mcp": {mcp_key: {"type": "remote", "url": mcp_url, "headers": {"Authorization": f"Bearer {mcp_token}"}, "enabled": True}}, "permission": permission})
        transient.append(config_path)
        env.update({"OPENCODE_CONFIG": str(config_path), "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true", "OPENCODE_DISABLE_CLAUDE_CODE": "true", "OPENCODE_DISABLE_SHARE": "true"})
        command = [str(executable), "run", "--format", "json", "--model", "archestra-native/kimi-for-coding"]
        if args.resume_session:
            command.extend(["--session", args.resume_session])
        if args.scenario.startswith("fork-"):
            command.append("--fork")
        command.append(prompt)
    return command, env, transient


def run_process(
    command: list[str],
    env: dict[str, str],
    timeout: int,
    reviewer_command: str | None,
    run_dir: Path,
    scenario: str,
    client: str,
    request_key: str,
) -> tuple[int, str, str, dict[str, Any] | None]:
    process = subprocess.Popen(command, cwd=env["HOME"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    reviewer: dict[str, Any] | None = None
    try:
        if reviewer_command:
            # The deployment-owned command must poll/authorize a pending test offer;
            # this harness never fabricates a human session or approval.
            time.sleep(2)
            reviewer = run_test_reviewer(reviewer_command, run_dir, scenario, client, request_key)
        stdout, stderr = process.communicate(timeout=timeout)
        return process.returncode, bounded_decode(stdout), bounded_decode(stderr), reviewer
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        return 124, bounded_decode(stdout), bounded_decode(stderr), reviewer
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=10)
        raise


def run_compaction_phase(args: argparse.Namespace, command: list[str], env: dict[str, str], run_dir: Path, private_marker: str) -> dict[str, Any] | None:
    if not args.scenario.startswith("compact-"):
        return None
    if args.client == "codex":
        # This is the stock V1 auto-compaction control, not an instruction to the model.
        return {"mechanism": "codex-model_auto_compact_token_limit", "threshold": 500}
    compact_command = claude_resume_compaction_command(command)
    exit_code, stdout, stderr, _ = run_process(compact_command, env, args.timeout, None, run_dir, args.scenario, args.client, "compaction-control")
    write_text(run_dir / "compaction.stdout.log", sanitize(stdout, private_marker))
    write_text(run_dir / "compaction.stderr.log", sanitize(stderr, private_marker))
    if exit_code != 0:
        raise SystemExit("native Claude compaction command failed; refusing an unproven post-compaction case")
    return {"mechanism": "claude-slash-compact", "exit_code": exit_code}


def compaction_mechanism(client: str) -> str:
    return {"claude": "claude-slash-compact", "codex": "codex-model_auto_compact_token_limit", "opencode": "unavailable"}[client]


def claude_allowed_tools(
    args: argparse.Namespace,
    gateway: dict[str, Any] | None,
    mcp_key: str,
) -> list[str]:
    if gateway:
        tools = [f"mcp__{mcp_key}__archestra__run_tool"]
    else:
        tools = [
            f"mcp__{mcp_key}__read_source",
            f"mcp__{mcp_key}__publish",
            f"mcp__{mcp_key}__protected_publish",
        ]
    if args.scenario.startswith("child-"):
        if args.client != "claude":
            raise SystemExit("native Agent lifecycle scenarios require Claude")
        return ["Agent", *tools]
    return tools


def claude_resume_compaction_command(command: list[str]) -> list[str]:
    """Use Claude's slash command with the supplied --resume session, never a model summary prompt."""
    compact: list[str] = []
    index = 0
    while index < len(command):
        item = command[index]
        if item == "--session-id":
            index += 2
            continue
        compact.append(item)
        index += 1
    if len(compact) < 2 or compact[-2] != "-p":
        raise SystemExit("native Claude command has no print prompt to replace")
    compact[-1] = "/compact"
    return compact


def run_test_reviewer(command_text: str, run_dir: Path, scenario: str, client: str, request_key: str) -> dict[str, Any]:
    request_path = run_dir / "review-request.json"
    write_json(request_path, {"actor_kind": "automated-test-reviewer", "scenario": scenario, "client": client, "request_key": request_key})
    command = shlex.split(command_text) + ["--request", str(request_path)]
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=90, env=os.environ.copy())
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError:
        response = {"actor_kind": "invalid", "status": "invalid-json"}
    if not isinstance(response, dict):
        response = {"actor_kind": "invalid", "status": "invalid-shape"}
    review_id = response.get("review_id")
    summary = {"status": response.get("status"), "actor_kind": response.get("actor_kind"), "exit_code": completed.returncode, "review_id": review_id if isinstance(review_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,200}", review_id) else None}
    if summary["actor_kind"] != "automated-test-reviewer":
        raise SystemExit("reviewer command must identify exactly as automated-test-reviewer")
    if not summary["review_id"]:
        raise SystemExit("reviewer command must return a bounded review_id")
    write_json(run_dir / "reviewer-result.json", redact_reviewer(summary))
    return summary


def create_fixture_run(base_url: str, admin_token: str, run_id: str) -> None:
    request = Request(f"{base_url.rstrip('/')}/admin/runs/{run_id}", method="POST", headers={"authorization": f"Bearer {admin_token}"})
    try:
        response = fixture_admin_request(request)
        if response.status not in {200, 201}:
            raise SystemExit("native fixture refused run initialization")
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise SystemExit("native fixture run initialization is unavailable") from error


def fixture_summary(base_url: str, admin_token: str, run_id: str) -> dict[str, Any]:
    request = Request(f"{base_url.rstrip('/')}/admin/runs/{run_id}/state", headers={"authorization": f"Bearer {admin_token}"})
    try:
        response = fixture_admin_request(request)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise SystemExit("native fixture state endpoint is unavailable") from error
    if response.status != 200:
        raise SystemExit(
            f"native fixture state endpoint returned HTTP {response.status} "
            f"with content type {response.content_type}"
        )
    body = response.read()
    try:
        state = json.loads(body)
    except json.JSONDecodeError as error:
        raise SystemExit(
            f"native fixture state endpoint returned invalid JSON "
            f"(HTTP {response.status}, content type {response.content_type}, "
            f"body bytes {len(body)})"
        ) from error
    if not isinstance(state, dict):
        raise SystemExit(
            f"native fixture state endpoint returned a non-object JSON value "
            f"(HTTP {response.status}, content type {response.content_type})"
        )
    return {key: state.get(key) for key in ("run_id", "publication_count", "job_count", "private_marker_in_publication", "public_value_only", "audit_count", "audit_outcomes")}


def fixture_admin_request(request: Request) -> Any:
    """Fixture run setup is idempotent, so survive a replaced local port-forward."""
    error: OSError | None = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=15) as response:
                return SimpleNamespace(
                    status=response.status,
                    content_type=response.headers.get_content_type(),
                    read=BytesIO(response.read()).read,
                )
        except (URLError, TimeoutError, OSError) as caught:
            error = caught
            if attempt < 2:
                time.sleep(0.2 * (attempt + 1))
    assert error is not None
    raise error


def archive_phase_trace(run_dir: Path) -> None:
    configured = os.environ.get("APPA_NATIVE_LIVE_PHASE_TRACE_LOG")
    if not configured:
        return
    source = Path(configured)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 16 * 1024 * 1024:
        raise SystemExit("per-run backend phase trace is unavailable or invalid")
    destination = run_dir / "backend-phase-trace.jsonl"
    shutil.copyfile(source, destination)
    os.chmod(destination, 0o600)
    cursor_path = os.environ.get("APPA_NATIVE_LIVE_PHASE_TRACE_CURSOR")
    if cursor_path:
        cursor = Path(cursor_path)
        if cursor.is_symlink() or not cursor.is_file() or cursor.stat().st_size > 64 * 1024:
            raise SystemExit("per-run backend phase cursor is unavailable or invalid")
        cursor_destination = run_dir / "backend-phase-trace-cursor.json"
        shutil.copyfile(cursor, cursor_destination)
        os.chmod(cursor_destination, 0o600)


def collect_runtime_evidence(args: argparse.Namespace, run_dir: Path, run_id: str, request_key: str, reviewer: dict[str, Any] | None, fixtures: dict[str, str]) -> dict[str, Any]:
    command = runtime_evidence_command(args) + ["--scenario", args.scenario, "--client", args.client, "--run-id", run_id, "--request-key", request_key, "--run-dir", str(run_dir), "--agent-id", args.agent_id]
    fixture_evidence_path = run_dir / "fixture-evidence.json"
    if fixture_evidence_path.is_file():
        command.extend(["--fixture-evidence", str(fixture_evidence_path)])
    if args.evidence_mode == "qualifying":
        assert args.gateway_profile is not None
        command.extend(["--gateway-profile", str(args.gateway_profile)])
    if reviewer:
        command.extend(["--review-id", str(reviewer["review_id"]), "--test-reviewer-id-sha256", str(args.test_reviewer_id_sha256)])
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60, env=os.environ.copy())
    if result.returncode != 0:
        diagnostic = sanitize(bounded_decode(result.stderr.encode()), fixtures["private_marker"])
        write_text(run_dir / "runtime-evidence-error.private.log", diagnostic)
        return {"collector_status": "failed", "exit_code": result.returncode, "diagnostic_artifact": "runtime-evidence-error.private.log"}
    try:
        evidence = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"collector_status": "invalid-json"}
    if not isinstance(evidence, dict):
        return {"collector_status": "invalid-shape"}
    sanitized = sanitize_json(evidence, fixtures["private_marker"])
    write_json(run_dir / "runtime-evidence.json", sanitized)
    return sanitized


def collect_fixture_evidence(args: argparse.Namespace, run_dir: Path, run_id: str, request_key: str, fixtures: dict[str, str]) -> dict[str, Any]:
    evidence = fixture_observer_request(args, run_id, request_key)
    if evidence is None:
        return {"collector_status": "fixture-observer-unavailable"}
    if not isinstance(evidence, dict):
        return {"collector_status": "fixture-observer-invalid-shape"}
    sanitized = sanitize_json(evidence, fixtures["private_marker"])
    write_json(run_dir / "fixture-evidence.json", sanitized)
    return sanitized


def verify_fixture_observer(args: argparse.Namespace, run_id: str) -> dict[str, Any] | None:
    if args.evidence_mode != "qualifying":
        return None
    value = fixture_observer_request(args, run_id, None)
    required_capabilities = {
        "append_only_audit_api",
        "canonical_arguments_sha256",
        "source_host_provenance",
        "fixture_event_sequences",
        "effect_commit_timestamp",
        "result_digest",
        "service_instance_identity",
    }
    capabilities = value.get("capabilities") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or value.get("source") != "trusted-fixture-audit/v1"
        or not isinstance(capabilities, list)
        or not all(isinstance(capability, str) for capability in capabilities)
        or not required_capabilities.issubset(set(capabilities))
    ):
        raise SystemExit("trusted fixture observer is not ready for the qualifying evidence contract")
    return {"source": value["source"], "capabilities": sorted(required_capabilities)}


def verify_runtime_trace_observer(args: argparse.Namespace) -> dict[str, Any] | None:
    if args.evidence_mode != "qualifying":
        return None
    command = runtime_evidence_command(args) + ["--readiness"]
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30, env=os.environ.copy())
        value = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        value = None
    required_capabilities = {
        "authorization_receipt",
        "proposal_socket_write_finish",
        "result_admission_receipt",
        "continuation_socket_write_finish",
    }
    capabilities = value.get("capabilities") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or value.get("source") != "backend-phase-trace/v1"
        or not isinstance(capabilities, list)
        or not all(isinstance(capability, str) for capability in capabilities)
        or not required_capabilities.issubset(set(capabilities))
    ):
        raise SystemExit("backend phase-trace reader is not ready for qualifying evidence")
    return {"source": value["source"], "capabilities": sorted(required_capabilities)}


def runtime_evidence_command(args: argparse.Namespace) -> list[str]:
    if args.runtime_evidence_command:
        return shlex.split(args.runtime_evidence_command)
    return ["bash", str(ROOT / "backend-phase-trace-reader.sh")]


def fixture_observer_request(args: argparse.Namespace, run_id: str | None, request_key: str | None) -> dict[str, Any] | None:
    if args.fixture_evidence_command:
        command = shlex.split(args.fixture_evidence_command) + (["--readiness"] if run_id is None else ["--run-id", run_id, "--request-key", str(request_key or ""), "--scenario", getattr(args, "scenario", "")])
        try:
            result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60, env=os.environ.copy())
            value = json.loads(result.stdout) if result.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None
    if not args.fixture_url:
        return None
    if run_id is None:
        return None
    path = f"/admin/runs/{run_id}/observer"
    try:
        return fixture_admin_json(args.fixture_url, required_env("APPA_NATIVE_FIXTURE_ADMIN_TOKEN"), path)
    except SystemExit:
        return None


def fixture_admin_json(base_url: str, admin_token: str, path: str) -> dict[str, Any]:
    request = Request(f"{base_url.rstrip('/')}{path}", headers={"authorization": f"Bearer {admin_token}"})
    try:
        with urlopen(request, timeout=15) as response:
            value = json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise SystemExit("trusted fixture audit endpoint is unavailable") from error
    if not isinstance(value, dict):
        raise SystemExit("trusted fixture audit endpoint returned an invalid object")
    return value


def verify_client_identity(args: argparse.Namespace) -> dict[str, Any]:
    launcher = resolve_launcher(args)
    resolved_path, symlink_chain, interpreter = resolve_executable(launcher)
    version = client_version(resolved_path)
    expected_version = STOCK_CLIENT_VERSIONS[args.client]
    identity = {
        "client": args.client,
        "expected_version": expected_version,
        "observed_version": version,
        "launcher_path": str(launcher),
        "resolved_path": str(resolved_path),
        "symlink_chain": symlink_chain,
        "sha256": sha256_file(resolved_path),
        "interpreter": interpreter,
    }
    if args.evidence_mode == "diagnostic":
        identity["provenance_verified"] = False
        identity["qualification"] = "diagnostic-only"
        return identity
    if version != expected_version:
        raise SystemExit(f"stock {args.client} version must be {expected_version}, observed {version}")
    if args.stock_provenance is None:
        raise SystemExit("qualifying execution requires --stock-provenance")
    provenance = read_verified_provenance(args.stock_provenance)
    expected = provenance["clients"].get(args.client)
    if not isinstance(expected, dict):
        raise SystemExit(f"verified provenance has no {args.client} entry")
    if expected.get("version") != expected_version:
        raise SystemExit("verified provenance version does not match the qualifying stock version")
    if expected.get("sha256") != identity["sha256"]:
        raise SystemExit("client executable digest does not match verified provenance")
    expected_install_identity = expected.get("install_identity_sha256")
    install_fields = {key: value for key, value in expected.items() if key != "install_identity_sha256"}
    if not isinstance(expected_install_identity, str) or expected_install_identity != sha256(json.dumps(install_fields, sort_keys=True, separators=(",", ":")).encode()).hexdigest():
        raise SystemExit("verified provenance installation identity is invalid")
    expected_launcher = expected.get("launcher_path")
    expected_resolved = expected.get("resolved_path")
    if not isinstance(expected_launcher, str) or not isinstance(expected_resolved, str):
        raise SystemExit("verified provenance requires launcher_path and resolved_path")
    if Path(expected_launcher).resolve() != launcher.resolve() or Path(expected_resolved).resolve() != resolved_path:
        raise SystemExit("client launcher or resolved executable does not match verified provenance")
    identity["provenance_verified"] = True
    identity["provenance_sha256"] = sha256_file(args.stock_provenance)
    identity["qualification"] = "stock-client-verified"
    return identity


def resolve_launcher(args: argparse.Namespace) -> Path:
    if args.evidence_mode == "qualifying":
        if args.client_bin:
            raise SystemExit("--client-bin is diagnostic-only; use --stock-client-bin for a qualifying launcher")
        selected = str(args.stock_client_bin) if args.stock_client_bin else shutil.which(args.client)
    else:
        selected = args.client_bin or shutil.which(args.client)
    if not selected:
        raise SystemExit(f"client executable unavailable: {args.client_bin or args.client}")
    launcher = Path(selected).expanduser().absolute()
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise SystemExit(f"client executable unavailable: {launcher}")
    return launcher


def resolve_executable(launcher: Path) -> tuple[Path, list[str], dict[str, str] | None]:
    chain: list[str] = [str(launcher)]
    current = launcher
    while current.is_symlink():
        target = Path(os.readlink(current))
        current = (current.parent / target).absolute() if not target.is_absolute() else target
        chain.append(str(current))
    resolved = current.resolve()
    if str(resolved) != chain[-1]:
        chain.append(str(resolved))
    try:
        with resolved.open("rb") as handle:
            first_line_bytes = handle.readline(4096)
    except OSError as error:
        raise SystemExit("unable to read resolved client executable") from error
    if not first_line_bytes.startswith(b"#!"):
        return resolved, chain, None
    try:
        first_line = first_line_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise SystemExit("client wrapper has an invalid shebang") from error
    parts = shlex.split(first_line[2:].strip())
    if not parts:
        raise SystemExit("client wrapper has an invalid shebang")
    interpreter_name = parts[0]
    # `env node` is a common package-manager shim. Record the actual runtime
    # executable rather than treating `/usr/bin/env` as the client interpreter.
    if Path(interpreter_name).name == "env" and len(parts) > 1:
        interpreter_name = next((part for part in parts[1:] if not part.startswith("-")), "")
    candidate = Path(interpreter_name) if "/" in interpreter_name else Path(shutil.which(interpreter_name) or "")
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise SystemExit("client wrapper interpreter is unavailable")
    interpreter = candidate.resolve()
    return resolved, chain, {"path": str(interpreter), "sha256": sha256_file(interpreter)}


def client_version(executable: Path) -> str:
    try:
        completed = subprocess.run([str(executable), "--version"], check=False, capture_output=True, text=True, timeout=20, env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")})
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit("unable to obtain stock client version") from error
    if completed.returncode != 0:
        raise SystemExit("stock client version command failed")
    match = re.search(r"\b(\d+\.\d+\.\d+)\b", bounded_decode(completed.stdout.encode()))
    if not match:
        raise SystemExit("stock client version output has no semantic version")
    return match.group(1)


def read_verified_provenance(path: Path | None) -> dict[str, Any]:
    if path is None or path.is_symlink() or not path.is_file():
        raise SystemExit("verified provenance must be a regular file")
    metadata = path.stat()
    if metadata.st_uid != os.geteuid() or (metadata.st_mode & 0o777) != 0o600:
        raise SystemExit("verified provenance must be owned by the harness user with mode 0600")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("verified provenance is invalid JSON") from error
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("generator") != "native-live-runner/stock-provenance-v1" or not isinstance(value.get("clients"), dict):
        raise SystemExit("verified provenance has an invalid schema")
    return value


def provision_stock_provenance(args: argparse.Namespace) -> int:
    if args.stock_provenance is None:
        raise SystemExit("--provision-stock-provenance requires --stock-provenance")
    clients: dict[str, Any] = {}
    for client, expected_version in STOCK_CLIENT_VERSIONS.items():
        discovered = shutil.which(client)
        launcher = Path(discovered).absolute() if discovered else None
        if launcher is None or not launcher.is_file() or not os.access(launcher, os.X_OK):
            raise SystemExit(f"stock launcher is unavailable from PATH: {client}")
        resolved_path, symlink_chain, interpreter = resolve_executable(launcher)
        version = client_version(resolved_path)
        if version != expected_version:
            raise SystemExit(f"stock {client} version must be {expected_version}, observed {version}")
        digest = sha256_file(resolved_path)
        installation = {
            "launcher_path": str(launcher),
            "resolved_path": str(resolved_path),
            "symlink_chain": symlink_chain,
            "version": version,
            "sha256": digest,
            "interpreter": interpreter,
        }
        installation["install_identity_sha256"] = sha256(json.dumps(installation, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        clients[client] = installation
    manifest = {
        "version": 1,
        "generator": "native-live-runner/stock-provenance-v1",
        "generated_at": dt.datetime.now(tz=dt.UTC).isoformat(),
        "clients": clients,
    }
    write_private_manifest(args.stock_provenance, manifest)
    print(json.dumps({"status": "stock-provenance-created", "path": str(args.stock_provenance), "clients": {name: {"version": item["version"], "sha256": item["sha256"], "install_identity_sha256": item["install_identity_sha256"]} for name, item in clients.items()}}, sort_keys=True))
    return 0


def write_private_manifest(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


def read_gateway_profile(path: Path | None) -> dict[str, Any]:
    if path is None or path.is_symlink() or not path.is_file():
        raise SystemExit("qualifying execution requires an explicit registry-derived gateway profile; direct fixture MCP is diagnostic-only")
    metadata = path.stat()
    if metadata.st_uid != os.geteuid() or (metadata.st_mode & 0o777) != 0o600:
        raise SystemExit("gateway profile must be owned by the harness user with mode 0600")
    try:
        profile = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("gateway profile is invalid") from error
    if not isinstance(profile, dict):
        raise SystemExit("gateway profile is invalid")
    required = ("url", "token_env", "client_server_key", "mcp_server_name", "tool_names")
    if any(not isinstance(profile.get(key), str) for key in required[:-1]) or not isinstance(profile.get("tool_names"), dict):
        raise SystemExit("gateway profile is incomplete")
    from urllib.parse import urlparse

    parsed = urlparse(str(profile["url"]))
    profile_id = profile.get("profile_id")
    server_id = profile.get("mcp_server_id")
    if profile.get("source") != "archestra-registry-assignment/v1" or not isinstance(profile_id, str) or not isinstance(server_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", profile_id) or not re.fullmatch(r"[0-9a-f-]{36}", server_id) or parsed.path != f"/v1/mcp/{profile_id}":
        raise SystemExit("gateway profile must be a registry-derived assignment for /v1/mcp/:profileId")
    tool_names = profile["tool_names"]
    if set(tool_names) != {"read_source", "publish", "protected_publish"} or not all(isinstance(value, str) and value for value in tool_names.values()):
        raise SystemExit("gateway profile tool names are invalid")
    return profile


def gateway_public_identity(profile: dict[str, Any] | None) -> dict[str, Any] | None:
    if profile is None:
        return None
    return {"url": profile["url"], "profile_id": profile["profile_id"], "mcp_server_id": profile["mcp_server_id"], "mcp_server_name": profile["mcp_server_name"], "tool_names": profile["tool_names"]}


def verify_gateway_control_inventory(profile: dict[str, Any], token_file: Path | None = None) -> dict[str, Any]:
    payload = {"jsonrpc": "2.0", "id": "qualifying-gateway-inventory", "method": "tools/list", "params": {}}
    request = Request(
        str(profile["url"]),
        data=json.dumps(payload, separators=(",", ":")).encode(),
        headers={
            "Authorization": f"Bearer {gateway_token(str(profile['token_env']), token_file)}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            value = json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise SystemExit("qualifying execution requires an authenticated gateway control inventory") from error
    result = value.get("result") if isinstance(value, dict) else None
    tools = result.get("tools") if isinstance(result, dict) else None
    return project_gateway_control_inventory(profile, tools)


def project_gateway_control_inventory(profile: dict[str, Any], tools: Any) -> dict[str, Any]:
    server_key = profile.get("client_server_key")
    if not isinstance(server_key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", server_key) or not isinstance(tools, list):
        raise SystemExit("gateway control inventory has an invalid registry identity")
    methods = sorted(
        tool["name"]
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    )
    if methods != list(GATEWAY_CONTROL_METHODS) or len(methods) != len(tools):
        raise SystemExit("gateway control inventory must expose exactly the reviewed methods")
    prefix = f"mcp__{server_key}__"
    return {
        "source": "authenticated-mcp-tools-list/v1",
        "profile_id": profile["profile_id"],
        "server_key": server_key,
        "methods": methods,
        "client_tool_names": [f"{prefix}{method}" for method in methods],
    }


def gateway_token(name: str, token_file: Path | None = None) -> str:
    inherited = os.environ.get(name)
    if inherited:
        return inherited
    if token_file is None or token_file.is_symlink() or not token_file.is_file():
        raise SystemExit("gateway token must be supplied through its profile environment variable or --gateway-token-file")
    metadata = token_file.stat()
    if metadata.st_uid != os.geteuid() or (metadata.st_mode & 0o777) != 0o600:
        raise SystemExit("registry gateway token reference must be owned by the harness user with mode 0600")
    try:
        lines = token_file.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise SystemExit("registry gateway token reference is unreadable") from error
    return parse_env_reference(lines, name)


def parse_env_reference(lines: list[str], name: str) -> str:
    """Read one opaque KEY=value reference without evaluating shell syntax."""
    values: list[str] = []
    for line in lines:
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=([A-Za-z0-9._~+/=-]{1,8192})", line)
        if match is None:
            raise SystemExit("gateway token reference must contain plain KEY=value entries")
        if match.group(1) == name:
            values.append(match.group(2))
    if len(values) != 1 or any(character.isspace() for character in values[0]):
        raise SystemExit("gateway token reference has an invalid token entry")
    return values[0]


def scenario_prompt(template: str, request_key: str, run_id: str, gateway: dict[str, Any] | None) -> str:
    prompt = template.format(request_key=request_key, run_id=run_id)
    if gateway is None:
        return prompt
    for fixture_name, gateway_name in gateway["tool_names"].items():
        prompt = prompt.replace(f"appa_fixture.{fixture_name}", gateway_name)
        prompt = prompt.replace(f"mcp__appa_fixture__{fixture_name}", gateway_name)
    wrapper = f"mcp__{gateway['client_server_key']}__archestra__run_tool"
    return (
        f"{prompt}\n\n"
        f"The fixture names above are registered targets behind the {wrapper} gateway tool, "
        "not direct client tools. For every fixture operation, call that wrapper with "
        "tool_name set to the stated target and tool_args set to that operation's arguments."
    )


def verify_client_identity_stable(identity: dict[str, Any]) -> None:
    executable = Path(str(identity["resolved_path"]))
    if not executable.is_file() or sha256_file(executable) != identity["sha256"]:
        raise SystemExit("client executable changed during execution; evidence is invalid")
    interpreter = identity.get("interpreter")
    if isinstance(interpreter, dict):
        path = Path(str(interpreter.get("path", "")))
        if not path.is_file() or sha256_file(path) != interpreter.get("sha256"):
            raise SystemExit("client wrapper interpreter changed during execution; evidence is invalid")


def configuration_fingerprint(args: argparse.Namespace, provider_base: str, command: list[str] | None = None, gateway: dict[str, Any] | None = None) -> dict[str, Any]:
    configuration = {
        "client": args.client,
        "provider_base_url": provider_base,
        "fixture_observer_origin": fixture_origin(args.fixture_url),
        "mcp_gateway_url": gateway["url"] if gateway else None,
        "model": {"claude": "claude-haiku-4-5", "codex": "gpt-5.4", "opencode": "kimi-for-coding"}[args.client],
        "mcp_transport": "streamable-http",
        "environment_names": sorted({"HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TERM", "APPA_NATIVE_FIXTURE_TOKEN", *({"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"} if args.client == "claude" else {"OPENAI_API_KEY", "CODEX_HOME"} if args.client == "codex" else {"OPENCODE_CONFIG"})}),
    }
    if command is not None:
        configuration["argv"] = sanitize_argv(command)
        configuration["argv_sha256"] = sha256(json.dumps(command, separators=(",", ":")).encode()).hexdigest()
    return {"sha256": sha256(json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "sanitized": configuration}


def archive_harness_attestation(
    run_dir: Path,
    client_identity: dict[str, Any],
    configuration: dict[str, Any],
    gateway_control_inventory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sources = {
        name: archive_harness_source(run_dir, source)
        for name, source in SOURCE_ARCHIVE_FILES.items()
    }
    manifest = {"version": SOURCE_ARCHIVE_VERSION, "files": sources}
    manifest_path = run_dir / "harness-sources" / "source-manifest.json"
    write_json(manifest_path, manifest)
    manifest_content = manifest_path.read_bytes()
    attestation = {
        "pipeline_version": PIPELINE_VERSION,
        "source_archive_version": SOURCE_ARCHIVE_VERSION,
        "source_archive": {
            "manifest": {
                "name": manifest_path.name,
                "sha256": sha256(manifest_content).hexdigest(),
                "bytes": len(manifest_content),
                "snapshot": str(manifest_path.relative_to(run_dir)),
            },
            "files": sources,
        },
        "configuration_sha256": configuration["sha256"],
        "client_binary": {
            "version": client_identity["observed_version"],
            "sha256": client_identity["sha256"],
        },
        "gateway_control_inventory": gateway_control_inventory,
    }
    write_json(run_dir / "harness-attestation.json", attestation)
    return attestation


def archive_harness_source(run_dir: Path, source: Path) -> dict[str, Any]:
    """Persist the exact harness bytes used by this run beside their digest."""
    try:
        content = source.read_bytes()
    except OSError as error:
        raise SystemExit(f"harness source {source.name} is unreadable") from error
    archive_dir = run_dir / "harness-sources"
    archive_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(archive_dir, 0o700)
    snapshot = archive_dir / source.name
    temporary = snapshot.with_suffix(f"{snapshot.suffix}.tmp")
    temporary.write_bytes(content)
    os.chmod(temporary, 0o600)
    temporary.replace(snapshot)
    os.chmod(snapshot, 0o600)
    return {
        "name": source.name,
        "sha256": sha256(content).hexdigest(),
        "bytes": len(content),
        "snapshot": str(snapshot.relative_to(run_dir)),
    }


def verify_source_archive(run_dir: Path) -> None:
    if run_dir.is_symlink() or not run_dir.is_dir():
        raise SystemExit("source archive run directory is unavailable")
    attestation = read_json(run_dir / "harness-attestation.json")
    archive = attestation.get("source_archive")
    if attestation.get("source_archive_version") != SOURCE_ARCHIVE_VERSION or not isinstance(archive, dict):
        raise SystemExit("source archive version is unsupported or incomplete")
    manifest_identity = archive.get("manifest")
    files = archive.get("files")
    if not isinstance(manifest_identity, dict) or not isinstance(files, dict):
        raise SystemExit("source archive manifest is unavailable")
    manifest_path = archive_snapshot_path(run_dir, manifest_identity)
    manifest_content = read_archive_file(manifest_path)
    if manifest_identity.get("bytes") != len(manifest_content) or manifest_identity.get("sha256") != sha256(manifest_content).hexdigest():
        raise SystemExit("source archive manifest digest does not match")
    try:
        manifest = json.loads(manifest_content)
    except json.JSONDecodeError as error:
        raise SystemExit("source archive manifest is invalid") from error
    if not isinstance(manifest, dict) or manifest.get("version") != SOURCE_ARCHIVE_VERSION or manifest.get("files") != files:
        raise SystemExit("source archive manifest does not match attestation")
    if set(files) != set(SOURCE_ARCHIVE_FILES):
        raise SystemExit("source archive dependency set is incomplete")
    archive_dir = run_dir / "harness-sources"
    if archive_dir.is_symlink() or not archive_dir.is_dir() or archive_dir.stat().st_mode & 0o777 != 0o700:
        raise SystemExit("source archive directory has invalid permissions")
    for identity in files.values():
        if not isinstance(identity, dict):
            raise SystemExit("source archive dependency identity is invalid")
        content = read_archive_file(archive_snapshot_path(run_dir, identity))
        if identity.get("bytes") != len(content) or identity.get("sha256") != sha256(content).hexdigest():
            raise SystemExit("source archive dependency digest does not match")


def archive_snapshot_path(run_dir: Path, identity: dict[str, Any]) -> Path:
    snapshot = identity.get("snapshot")
    if not isinstance(snapshot, str):
        raise SystemExit("source archive dependency snapshot is invalid")
    path = run_dir / snapshot
    if path.parent != run_dir / "harness-sources":
        raise SystemExit("source archive dependency escapes the archive directory")
    return path


def read_archive_file(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o777 != 0o600:
        raise SystemExit("source archive dependency is unavailable or has invalid permissions")
    try:
        return path.read_bytes()
    except OSError as error:
        raise SystemExit("source archive dependency is unreadable") from error


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("source archive attestation is invalid") from error
    if not isinstance(value, dict):
        raise SystemExit("source archive attestation is invalid")
    return value


def sanitize_argv(command: list[str]) -> list[str]:
    sanitized = redact_command(command)
    if sanitized:
        sanitized[0] = "<verified-client>"
        sanitized[-1] = "<scenario-prompt>"
    for index, item in enumerate(sanitized[:-1]):
        if item in {"--resume", "--session", "resume", "fork"}:
            sanitized[index + 1] = "<session-id>"
    return sanitized


def fixture_origin(value: str | None) -> str | None:
    if not value:
        return None
    from urllib.parse import urlparse

    parsed = urlparse(value)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else None


def sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str | None) -> str | None:
    return sha256(value.encode()).hexdigest() if value else None


def redact_reviewer(reviewer: dict[str, Any] | None) -> dict[str, Any] | None:
    if not reviewer:
        return None
    return {"status": reviewer.get("status"), "actor_kind": reviewer.get("actor_kind"), "exit_code": reviewer.get("exit_code"), "review_id_sha256": sha256_text(reviewer.get("review_id") if isinstance(reviewer.get("review_id"), str) else None)}


def sanitize(value: str, private_marker: str) -> str:
    redacted = re.sub(
        rf"{re.escape(private_marker)}\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+",
        "<redacted-fixture-source>",
        value,
    ).replace(private_marker, "<redacted-fixture-source>")
    for name, candidate in os.environ.items():
        if candidate and re.search(r"(?:KEY|TOKEN|SECRET|COOKIE|PASSWORD)", name, re.I):
            redacted = redacted.replace(candidate, f"<redacted:{name.lower()}>")
    return redacted


def sanitize_json(value: Any, private_marker: str) -> Any:
    if isinstance(value, str):
        return sanitize(value, private_marker)
    if isinstance(value, list):
        return [sanitize_json(item, private_marker) for item in value]
    if isinstance(value, dict):
        safe_evidence_fields = {
            "authorization_at",
            "authorization_receipt",
            "authorization_receipts",
            "request_key_hits",
            "runtime_request_key",
        }
        return {
            str(key): sanitize_json(item, private_marker)
            for key, item in value.items()
            if str(key) in safe_evidence_fields
            or not re.search(r"(?:key|token|secret|cookie|authorization)", str(key), re.I)
        }
    return value


def redact_command(command: list[str]) -> list[str]:
    return ["<transient-config>" if item.endswith(("claude-mcp.json", "opencode.json")) else item for item in command]


def bounded_decode(value: bytes) -> str:
    return value[:MAX_CAPTURE_BYTES].decode("utf-8", errors="replace")


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"required environment variable is absent: {name}")
    return value


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def utc_stamp() -> str:
    return dt.datetime.now(tz=dt.UTC).strftime("%Y%m%dT%H%M%SZ")


def write_json(path: Path, value: Any) -> None:
    write_text(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def write_private_json(path: Path, value: Any) -> None:
    write_text(path, json.dumps(value))


def write_text(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")
    os.chmod(path, 0o600)


if __name__ == "__main__":
    raise SystemExit(main())
