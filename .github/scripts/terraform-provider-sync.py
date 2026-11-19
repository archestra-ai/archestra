#!/usr/bin/env python3
"""Start the Terraform Provider Sync agent on staging for one platform release.

sync-terraform-provider.yml runs this after a release is published. The agent
(archestra-ai/infra, archestra/automation) reads what changed in the release
and opens or updates a pull request on archestra-ai/terraform-provider-archestra.

The job holds no Archestra API key. It trades its GitHub OIDC token at
/api/workload-identity/token (RFC 8693) for a one-hour token of a service
account that can only run that agent, then starts the run. It does not wait:
a run takes far longer than the job should, and the agent reports in its pull
request.

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
RELEASE_TAG = re.compile(r"platform-v\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?")


def main(env):
    tag = env.get("RELEASE_TAG", "")
    if not RELEASE_TAG.fullmatch(tag):
        raise Failure(f"{tag!r} is not a platform release tag, such as platform-v1.5.0-rc.36.")
    for name, variable in [("SERVICE_ACCOUNT_ID", "TERRAFORM_PROVIDER_SYNC_SERVICE_ACCOUNT_ID"),
                           ("AGENT_ID", "TERRAFORM_PROVIDER_SYNC_AGENT_ID")]:
        if not UUID.fullmatch(env.get(name, "")):
            raise Failure(f"Set the {variable} repository variable (an output of archestra/automation in archestra-ai/infra).")
    run_url = start_run(env, message=message(tag, env.get("GITHUB_REPOSITORY", "archestra-ai/archestra")))
    print(f"Started Terraform Provider Sync for {tag}: {run_url}")
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(
                f"Started the Terraform Provider Sync agent for `{tag}`: [run]({run_url}).\n\n"
                "Its pull request appears on the `automation/platform-sync` branch of "
                "[terraform-provider-archestra](https://github.com/archestra-ai/terraform-provider-archestra/pulls).\n"
            )


def message(tag, repository):
    return (
        f"Platform release `{tag}` was published: https://github.com/{repository}/releases/tag/{tag}\n\n"
        "Update the Terraform and Crossplane providers for this release."
    )


if __name__ == "__main__":
    try:
        main(os.environ)
    except Failure as failure:
        print(f"::error::{failure}")
        sys.exit(1)
