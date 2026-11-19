#!/usr/bin/env python3
"""Start the VEX Triage agent on staging for one project's release.

vex-triage.yml runs this weekly for each project in PROJECTS (its latest
stable release) and on demand. The agent (archestra-ai/infra,
archestra/automation) scans the release's public images, decides for each
finding whether it affects the image as shipped, and opens or updates one pull
request in the project's repository that records those decisions in its VEX
document. It never merges: a person reviews every statement. The project's
releases then attest each image's statements next to its SBOMs
(archestra-ai/.github release-publish.yml, `vex-document`).

The job holds no Archestra API key (archestra_agent_run.py). It does not wait:
the agent reports in its pull request.

  vex-triage.py projects   prints the schedule matrix (each project, its
                           repository and its stable tag pattern)
  vex-triage.py            starts the run

Environment: PROJECT, RELEASE_TAG, BASE_URL (the API), PUBLIC_URL (the token
audience and the link to the run), SERVICE_ACCOUNT_ID, AGENT_ID, and the
runner's ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN
(`id-token: write`).
"""

import json
import os
import re
import sys

from archestra_agent_run import UUID, Failure, start_run

BRANCH = "automation/vex-triage"
DOCUMENT = "vex/openvex.json"
VERSION = r"(?P<version>\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?)"
# Every project whose releases attest VEX: its release tags, and the public
# name of each image a release publishes (release-publisher
# projects/<project>.json) with the tag it is published under. The VEX
# document names images by the last segment of the name.
PROJECTS = {
    "archestra": {
        "repository": "archestra-ai/archestra",
        "release_tag": "platform-v{version}",
        "image_tag": "{version}",
        "images": [
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
        ],
    },
    "openappa": {
        "repository": "archestra-ai/OpenAPPA",
        "release_tag": "v{version}",
        "image_tag": "v{version}",
        "images": [
            "ghcr.io/archestra-ai/appa-runtime",
            "ghcr.io/archestra-ai/appa-kagent-adk",
            "ghcr.io/archestra-ai/appa-kagent-adk-go",
            "ghcr.io/archestra-ai/golang-adk",
            "ghcr.io/archestra-ai/appa-demo-tools",
            "ghcr.io/archestra-ai/appa-demo-mocks",
        ],
    },
    "terraform-provider-archestra": {
        "repository": "archestra-ai/terraform-provider-archestra",
        "release_tag": "v{version}",
        "image_tag": "v{version}",
        # The Crossplane provider package, which holds the provider binary.
        "images": ["xpkg.upbound.io/archestra/provider-archestra"],
    },
}


def main(env):
    name = env.get("PROJECT", "")
    if name not in PROJECTS:
        raise Failure(f"{name!r} is not a project: {', '.join(PROJECTS)}.")
    project = PROJECTS[name]
    tag = env.get("RELEASE_TAG", "")
    # The tag is written into the agent's instructions: accept a release tag only.
    match = re.fullmatch(re.escape(project["release_tag"]).replace(re.escape("{version}"), VERSION), tag)
    if not match:
        example = project["release_tag"].format(version="1.2.3")
        raise Failure(f"{tag!r} is not a release tag of {project['repository']}, such as {example}.")
    for key, variable in [("SERVICE_ACCOUNT_ID", "VEX_TRIAGE_SERVICE_ACCOUNT_ID"), ("AGENT_ID", "VEX_TRIAGE_AGENT_ID")]:
        if not UUID.fullmatch(env.get(key, "")):
            raise Failure(f"Set the {variable} repository variable (an output of archestra/automation in archestra-ai/infra).")
    repository = project["repository"]
    run_url = start_run(env, message=message(project, tag, match["version"]))
    print(f"Started VEX Triage for {repository} {tag}: {run_url}")
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(
                f"Started the VEX Triage agent for `{repository}` `{tag}`: [run]({run_url}).\n\n"
                f"Its pull request appears on the `{BRANCH}` branch of "
                f"[{repository}](https://github.com/{repository}/pulls?q=head%3A{BRANCH}).\n"
            )


def matrix():
    """Each project for the weekly run, with a jq regex for its stable release tags."""
    return [
        {
            "project": name,
            "repository": project["repository"],
            "stable_tag": "^" + re.escape(project["release_tag"]).replace(re.escape("{version}"), r"[0-9]+\.[0-9]+\.[0-9]+") + "$",
        }
        for name, project in PROJECTS.items()
    ]


def message(project, tag, version):
    repository = project["repository"]
    image_tag = project["image_tag"].format(version=version)
    images = "\n".join(f"- `{image}:{image_tag}`" for image in project["images"])
    return (
        f"Repository: `{repository}`\n"
        f"Release: `{tag}` (https://github.com/{repository}/releases/tag/{tag})\n"
        f"VEX document: `{DOCUMENT}`\n"
        f"Branch: `{BRANCH}`\n\n"
        f"Triage the vulnerabilities of this release into the VEX document of the repository, and open or "
        f"update the pull request from the branch.\n\nIts public images:\n{images}\n"
    )


if __name__ == "__main__":
    if sys.argv[1:] == ["projects"]:
        print(json.dumps(matrix()))
        sys.exit(0)
    try:
        main(os.environ)
    except Failure as failure:
        print(f"::error::{failure}")
        sys.exit(1)
