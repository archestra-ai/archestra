#!/usr/bin/env python3
"""Start the VEX Triage agent on staging for one platform release.

vex-triage.yml runs this weekly and on demand. The agent (archestra-ai/infra,
archestra/automation) scans the release's public images, decides for each
finding whether it affects the image as shipped, and opens or updates one pull
request that records those decisions in vex/archestra.openvex.json. It never
merges: a person reviews every statement.

The job holds no Archestra API key (archestra_agent_run.py). It does not wait:
the agent reports in its pull request.

Environment: RELEASE_TAG, BASE_URL (the API), PUBLIC_URL (the token audience
and the link to the run), SERVICE_ACCOUNT_ID, AGENT_ID, and the runner's
ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN
(`id-token: write`).
"""

import os
import re
import sys

from archestra_agent_run import UUID, Failure, start_run

# The tag is written into the agent's instructions: accept a release tag only.
RELEASE_TAG = re.compile(r"platform-v(?P<version>\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?)")
BRANCH = "automation/vex-triage"
# Every image a platform release publishes, by its public name
# (.github/scripts/release-subjects.sh, release-publisher projects/archestra.json).
# The VEX document names them by the last segment.
IMAGES = [
    "docker.io/archestra/platform",
    "ghcr.io/archestra-ai/mcp-server-base",
    "ghcr.io/archestra-ai/sandbox-base",
    "ghcr.io/archestra-ai/p4-shim",
    "ghcr.io/archestra-ai/agent-claude-code",
    "ghcr.io/archestra-ai/agent-codex",
    "ghcr.io/archestra-ai/agent-copilot",
    "ghcr.io/archestra-ai/agent-grok",
    "ghcr.io/archestra-ai/agent-hermes",
    "ghcr.io/archestra-ai/agent-kimi",
    "ghcr.io/archestra-ai/agent-openclaw",
    "ghcr.io/archestra-ai/agent-opencode",
    # Published to Artifact Registry only.
    "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-archestra",
]


def main(env):
    tag = env.get("RELEASE_TAG", "")
    match = RELEASE_TAG.fullmatch(tag)
    if not match:
        raise Failure(f"{tag!r} is not a platform release tag, such as platform-v1.4.35.")
    for name, variable in [("SERVICE_ACCOUNT_ID", "VEX_TRIAGE_SERVICE_ACCOUNT_ID"), ("AGENT_ID", "VEX_TRIAGE_AGENT_ID")]:
        if not UUID.fullmatch(env.get(name, "")):
            raise Failure(f"Set the {variable} repository variable (an output of archestra/automation in archestra-ai/infra).")
    repository = env.get("GITHUB_REPOSITORY", "archestra-ai/archestra")
    run_url = start_run(env, message=message(tag, match["version"], repository))
    print(f"Started VEX Triage for {tag}: {run_url}")
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(
                f"Started the VEX Triage agent for `{tag}`: [run]({run_url}).\n\n"
                f"Its pull request appears on the `{BRANCH}` branch of "
                f"[{repository}](https://github.com/{repository}/pulls?q=head%3A{BRANCH}).\n"
            )


def message(tag, version, repository):
    images = "\n".join(f"- `{image}:{version}`" for image in IMAGES)
    return (
        f"Triage the vulnerabilities of platform release `{tag}` "
        f"(https://github.com/{repository}/releases/tag/{tag}) into `vex/archestra.openvex.json` of {repository}, "
        f"and open or update the pull request from `{BRANCH}`.\n\n"
        f"Its public images:\n{images}\n"
    )


if __name__ == "__main__":
    try:
        main(os.environ)
    except Failure as failure:
        print(f"::error::{failure}")
        sys.exit(1)
