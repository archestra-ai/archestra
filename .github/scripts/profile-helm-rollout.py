#!/usr/bin/env python3
"""Print a timestamped timeline of Helm hook and Deployment state changes."""

import argparse
import json
import signal
import subprocess
import time
from datetime import datetime, timezone


def describe(item: dict) -> str:
    kind = item.get("kind", "")
    spec = item.get("spec", {})
    status = item.get("status", {})

    if kind == "Job":
        return "active={active} succeeded={succeeded} failed={failed}".format(
            active=status.get("active", 0),
            succeeded=status.get("succeeded", 0),
            failed=status.get("failed", 0),
        )
    if kind == "Deployment":
        return "updated={updated} ready={ready} available={available}/{desired}".format(
            updated=status.get("updatedReplicas", 0),
            ready=status.get("readyReplicas", 0),
            available=status.get("availableReplicas", 0),
            desired=spec.get("replicas", 1),
        )
    if kind == "Pod":
        regular = status.get("containerStatuses", [])
        containers = status.get("initContainerStatuses", []) + regular
        waiting = [
            f"{container['name']}:{container['state']['waiting']['reason']}"
            for container in containers
            if container.get("state", {}).get("waiting", {}).get("reason")
        ]
        ready = sum(bool(container.get("ready")) for container in regular)
        return (
            f"phase={status.get('phase', 'Unknown')} ready={ready}/{len(regular)}"
            + (f" waiting={','.join(waiting)}" if waiting else "")
        )
    return "unknown"


def observe(namespace: str, release: str, interval: float) -> None:
    started = time.monotonic()
    previous: dict[str, str] = {}
    stopping = False
    query_failed = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    print(f"Helm rollout timeline: namespace={namespace} release={release}", flush=True)
    while not stopping:
        try:
            result = subprocess.run(
                [
                    "kubectl",
                    "get",
                    "pods,jobs,deployments",
                    "--namespace",
                    namespace,
                    "--selector",
                    f"app.kubernetes.io/instance={release}",
                    "--output",
                    "json",
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            if result.returncode != 0:
                raise ValueError("kubectl query failed")
            items = json.loads(result.stdout).get("items", [])
            current = {
                f"{item['kind']}/{item['metadata']['name']}"
                f"/{item['metadata']['uid']}": describe(item)
                for item in items
            }
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            if not query_failed:
                print("kubectl query failed; retrying", flush=True)
            query_failed = True
            time.sleep(interval)
            continue
        query_failed = False

        elapsed = time.monotonic() - started
        timestamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
        for name, state in sorted(current.items()):
            if previous.get(name) != state:
                print(f"+{elapsed:.1f}s {timestamp} {name}: {state}", flush=True)
        for name in sorted(previous.keys() - current.keys()):
            print(f"+{elapsed:.1f}s {timestamp} {name}: removed", flush=True)
        previous = current
        time.sleep(interval)

    print(f"Helm command finished at +{time.monotonic() - started:.1f}s", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--interval", type=float, default=2)
    args = parser.parse_args()
    observe(args.namespace, args.release, args.interval)


if __name__ == "__main__":
    main()
