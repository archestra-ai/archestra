"""Start an agent run on the staging Archestra from a GitHub Actions job.

The job holds no Archestra API key. It trades its GitHub OIDC token at
/api/workload-identity/token (RFC 8693) for a one-hour token of a service
account (a federated credential trusts the workflow file on main), then starts
the run. Used by terraform-provider-sync.py and vex-triage.py.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

UUID = re.compile(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
TIMEOUT_SECONDS = 30


class Failure(Exception):
    """An error to report on the job, without a traceback."""


def start_run(env, *, message):
    """Signs in as SERVICE_ACCOUNT_ID and starts a run of AGENT_ID with `message`. Returns the run's URL."""
    base_url, public_url = env["BASE_URL"].rstrip("/"), env["PUBLIC_URL"].rstrip("/")
    token = archestra_token(env, base_url=base_url, audience=public_url)
    run = request(
        f"{base_url}/api/agents/{env['AGENT_ID']}/runs",
        headers={"Authorization": token, "Content-Type": "application/json"},
        body=json.dumps({"message": message}).encode(),
        what="start the agent run",
    )
    run_id = run.get("taskId")
    if not isinstance(run_id, str) or not UUID.fullmatch(run_id):
        raise Failure("Archestra started no run: the answer has no run id.")
    return f"{public_url}/chat/runs/{run_id}"


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
