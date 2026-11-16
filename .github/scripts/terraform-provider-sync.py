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

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# The tag is written into the agent's instructions: accept a release tag only.
RELEASE_TAG = re.compile(r"platform-v\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?")
UUID = re.compile(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
TIMEOUT_SECONDS = 30


class Failure(Exception):
    """An error to report on the job, without a traceback."""


def main(env):
    tag = env.get("RELEASE_TAG", "")
    if not RELEASE_TAG.fullmatch(tag):
        raise Failure(f"{tag!r} is not a platform release tag, such as platform-v1.5.0-rc.36.")
    for name, variable in [("SERVICE_ACCOUNT_ID", "TERRAFORM_PROVIDER_SYNC_SERVICE_ACCOUNT_ID"),
                           ("AGENT_ID", "TERRAFORM_PROVIDER_SYNC_AGENT_ID")]:
        if not UUID.fullmatch(env.get(name, "")):
            raise Failure(f"Set the {variable} repository variable (an output of archestra/automation in archestra-ai/infra).")
    base_url, public_url = env["BASE_URL"].rstrip("/"), env["PUBLIC_URL"].rstrip("/")

    token = archestra_token(env, base_url=base_url, audience=public_url)
    run = request(
        f"{base_url}/api/agents/{env['AGENT_ID']}/runs",
        headers={"Authorization": token, "Content-Type": "application/json"},
        body=json.dumps({"message": message(tag, env.get("GITHUB_REPOSITORY", "archestra-ai/archestra"))}).encode(),
        what="start the agent run",
    )
    run_id = run.get("taskId")
    if not isinstance(run_id, str) or not UUID.fullmatch(run_id):
        raise Failure("Archestra started no run: the answer has no run id.")
    run_url = f"{public_url}/chat/runs/{run_id}"
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


def archestra_token(env, *, base_url, audience):
    request_url, request_token = env.get("ACTIONS_ID_TOKEN_REQUEST_URL"), env.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise Failure("No GitHub OIDC token available: the job needs id-token: write.")
    separator = "&" if "?" in request_url else "?"
    oidc_token = request(
        f"{request_url}{separator}{urllib.parse.urlencode({'audience': audience})}",
        headers={"Authorization": f"Bearer {request_token}"},
        what="get the job's GitHub OIDC token",
    ).get("value")
    if not oidc_token:
        raise Failure("GitHub issued no OIDC token.")
    print(f"::add-mask::{oidc_token}")
    token = request(
        f"{base_url}/api/workload-identity/token",
        body=urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
            "subject_token": oidc_token,
            "service_account_id": env["SERVICE_ACCOUNT_ID"],
        }).encode(),
        what="sign in to Archestra (the Audit log's \"Service account token exchanged\" event has the reason)",
    ).get("access_token")
    if not token:
        raise Failure("Archestra answered the token exchange without an access token.")
    print(f"::add-mask::{token}")
    return token


def request(url, *, headers=None, body=None, what):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers or {}),
                                    timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise Failure(f"Could not {what}: HTTP {error.code}: {refusal(error.read())}") from None
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise Failure(f"Could not {what}: {error}") from None


def refusal(body):
    """The reason in an error body: the API's {error: {message}} or the token endpoint's RFC 6749 pair."""
    try:
        error = json.loads(body).get("error")
        if isinstance(error, dict):
            return str(error.get("message") or "no reason given")
        return ": ".join(str(part) for part in [error, json.loads(body).get("error_description")] if part) or "no reason given"
    except (ValueError, AttributeError):
        return "no error body"


if __name__ == "__main__":
    try:
        main(os.environ)
    except Failure as failure:
        print(f"::error::{failure}")
        sys.exit(1)
