---
title: Workload Identity Federation
description: Let CI jobs and workloads sign in as a service account or an OAuth client with their own OIDC token instead of a stored key or secret
order: 6
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Let a CI job sign in as a service account with the OIDC token its platform already issues, so no Archestra API key sits in your CI secrets. A GitHub Actions job that deploys from `main` gets a one-hour token; the same workflow run from a pull request gets nothing.

Workload identity federation is an [Enterprise feature](/pricing). To manage a service account's or OAuth client's federated credentials, you need update access on it. See [Granular Access Control](/docs/admin/access-control#granular-access-control).

## When to Use It

Use a federated credential when the workload can get an OIDC token from its platform. Use an [API key](/docs/reference/api#service-accounts) for everything else.

- **GitHub Actions, GitLab CI, Google Cloud, Kubernetes, and Agent Substrate** issue OIDC tokens. Federate them.
- **A laptop script, a cron job on a plain VM, or a third-party tool** has no OIDC issuer. Give it an API key.

A federated job leaves nothing to rotate or leak: each token it gets expires after one hour, and deleting the credential stops it at once.

## Add a Federated Credential

A federated credential says which tokens to trust: their issuer, audience, subject, and any other claims you require.

1. Go to **Settings → Service Accounts** and open the account.
2. Open the **Federated Credentials** tab and click **Add credential**.
3. Pick the **Identity provider**. It fills in the **Issuer URL**.
4. Keep **Audience** as your Archestra URL, unless your issuer requires another value. The job must request its token with this audience.
5. Enter the **Subject**, exactly as the token's `sub` claim carries it.
6. Optional: under **Claim conditions**, click **Add condition** for each other claim that must match, such as `repository` or `ref`.
7. Click **Add**.

Every value matches exactly. There are no wildcards: to trust two branches or two environments, add two credentials. A service account holds up to 20.

### Subjects for Common Providers

| Provider | Issuer URL | Subject example |
| --- | --- | --- |
| GitHub Actions | `https://token.actions.githubusercontent.com` | `repo:acme/infra:environment:production`, `repo:acme/infra:ref:refs/heads/main`, or `repo:acme/infra:pull_request` |
| GitLab.com | `https://gitlab.com` | `project_path:acme/infra:ref_type:branch:ref:main` |
| Google Cloud | `https://accounts.google.com` | The numeric unique ID of the Google service account |
| Kubernetes | Your cluster's service account issuer | `system:serviceaccount:ci:deployer` |
| Agent Substrate | Your installation's public actor JWT issuer | `actor/support/triage` |

A GitHub Actions job that names an `environment:` gets the environment subject, so require the environment instead of the branch when you deploy through one.

## Declare Accounts in the Helm Chart

With the Helm chart, Archestra creates the service account and its federated credential on its first start, so one install can bring up Archestra and the workloads that manage it, such as the [Terraform or Crossplane provider](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs/guides/authentication), with no API key to mint and hand over.

1. List the accounts under `archestra.bootstrap.serviceAccounts` in your values:

   ```yaml
   archestra:
     bootstrap:
       serviceAccounts:
         - id: 6f1d7d2e-4a52-4c3e-9c1f-0d5b8a7e2b10
           name: crossplane
           roles:
             - fixed:agents:reader
             - fixed:skills:writer
           federatedCredentials:
             - name: crossplane provider
               issuer: https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE
               audience: https://archestra.example.com
               subject: system:serviceaccount:crossplane-system:provider-archestra
   ```

2. List under `roles` every role the account needs, and no more. Compose access from [granular roles](/docs/reference/permissions#granular-roles) such as `fixed:agents:reader`, or use a predefined role (`member`, `editor`, `admin`) or a custom role's identifier.
3. Set `id` to a UUID you choose, and configure the workload with it. The workload can then sign in on the first deploy, without looking the ID up.
4. Install or upgrade the chart. Archestra creates the accounts after its database migrations.

What to know:

- Archestra creates only what is missing, matched by name, on every start. It never changes or deletes an account or credential that exists, so edits in the UI, API, or Terraform stick.
- An account it cannot create, for an unknown role or a private issuer, is skipped and logged. Archestra still starts.
- The chart renders the list into [`ARCHESTRA_AUTH_SERVICE_ACCOUNT_BOOTSTRAP`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_SERVICE_ACCOUNT_BOOTSTRAP).

## Exchange a Token in GitHub Actions

The job asks GitHub for an OIDC token, then trades it for an Archestra token at `/api/workload-identity/token` ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) token exchange). When you add a federated credential, Archestra shows this request with the account's id already filled in.

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Sign in to Archestra
        env:
          ARCHESTRA_URL: https://archestra.example.com
          SERVICE_ACCOUNT_ID: 4f6c1b3e-2a5d-4e8f-9b7a-0c1d2e3f4a5b
        run: |
          OIDC_TOKEN=$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$ARCHESTRA_URL" | jq -r .value)
          ARCHESTRA_TOKEN=$(curl -sS --fail-with-body "$ARCHESTRA_URL/api/workload-identity/token" \
            -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
            -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
            -d subject_token="$OIDC_TOKEN" \
            -d service_account_id="$SERVICE_ACCOUNT_ID" | jq -r .access_token)
          echo "::add-mask::$ARCHESTRA_TOKEN"
          echo "ARCHESTRA_TOKEN=$ARCHESTRA_TOKEN" >> "$GITHUB_ENV"
      - name: Call the API as the service account
        run: curl -sS -H "Authorization: $ARCHESTRA_TOKEN" https://archestra.example.com/api/agents
```

The token acts as the service account, with the account's roles, wherever its API keys work. Send it the way you send an API key. When the exchange works, the credential's **Last used** time updates.

## Send the OIDC Token Itself

A workload that cannot run the exchange can send its OIDC token as the Bearer token, to the MCP Gateway, A2A, and the API. Agent Substrate is the usual case: its egress gateway writes the actor's JWT into the actor's requests, so the actor never holds a token to trade.

The token passes the same checks as an exchange. Exactly one service account may trust it: a token that matches credentials on two accounts acts as neither.

What to know:

- The LLM Proxy does not take service account tokens. To call it, [sign in as an OAuth client](#sign-in-as-an-oauth-client) instead.
- Each actor needs its own credential, since every value matches exactly. A service account holds up to 20.

### Agent Substrate

1. Expose your Substrate installation's actor JWT issuer at a public https host, as Substrate's [actor JWT federation guide](https://github.com/agent-substrate/substrate/blob/main/docs/guides/actor-jwt-federation.md) describes.
2. Add a federated credential: pick **Agent Substrate**, set **Issuer URL** to that issuer, and set **Subject** to the actor, such as `actor/support/triage`.
3. In the actor's egress policy, write its JWT into requests to Archestra, with your Archestra URL as the audience:

   ```yaml
   rules:
   - https:
       hostnames: ["archestra.example.com"]
       effects:
         replaceHeaders:
         - header: Authorization
           prefix: "Bearer "
           actorJwt:
             audiences: ["https://archestra.example.com"]
             expirationSeconds: 900
   ```

4. Have the actor send `Authorization: placeholder` to the MCP Gateway or A2A endpoint. The egress gateway replaces it, and skips requests without the header.

To check it works, call a tool through the gateway from the actor. The credential's **Last used** time updates.

## Sign In as an OAuth Client

Federate an [OAuth client](/docs/llm-proxy/authentication#call-as-the-app) when the workload calls the LLM Proxy, or needs the provider keys, gateways, and budget a client fixes. A nightly eval job then gets a one-hour LLM Proxy token with its GitHub OIDC token, and no client secret sits in CI.

1. Go to **Settings → OAuth Clients** and open a client that signs in **As itself**.
2. Open the **Federated Credentials** tab and click **Add credential**. The form is the same as a service account's.
3. In the job, send the OIDC token as the client assertion ([RFC 7523](https://www.rfc-editor.org/rfc/rfc7523)) in place of the secret:

   ```bash
   curl --request POST "$ARCHESTRA_URL/api/auth/oauth2/token" \
     --data-urlencode 'grant_type=client_credentials' \
     --data-urlencode "client_id=$CLIENT_ID" \
     --data-urlencode 'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer' \
     --data-urlencode "client_assertion=$OIDC_TOKEN" \
     --data-urlencode 'scope=llm:proxy'
   ```

4. Send `Authorization: Bearer <access_token>` as you would a token issued for the secret.

What to know:

- The token reaches what the client allows, with its provider keys, service account, and budget. The `sub` claim names the workload, not the client, so `client_id` is required.
- The secret keeps working. Send the secret or the assertion, never both.
- A refused assertion answers `401` with `invalid_client`. The **OAuth client signed in with an OIDC token** audit event records why, with the same reasons as the table below, plus `oauth_client_disabled`.

## What Gets Checked

Each exchange checks the token, then the credentials of the service account or OAuth client. Any failure refuses the exchange.

- **Signature:** RS256 or ES256, by a key from the issuer's published key set. Archestra fetches it only from an issuer one of the account's credentials names, and only over https from a public address.
- **Lifetime:** the token is not expired or not yet valid, with 30 seconds of clock skew. A token valid for more than 24 hours is refused, however much time it has left.
- **Match:** one credential's issuer, audience, subject, and claim conditions all match the token.
- **Account:** the service account or OAuth client is enabled.

Changing a credential's issuer, audience, subject, or conditions revokes the tokens it already issued, as does deleting it. Disabling the account stops them too.

## Troubleshooting

A refused exchange answers `400` with an `error` code. The **Audit** events in [Logs](/docs/insights/logs) show why: open the **Service account token exchanged** event for the account and read `reason`.

| Reason | Fix |
| --- | --- |
| `issuer_not_trusted` | No credential names the token's issuer. Compare the **Issuer URL** with the token's `iss`, including any trailing slash. |
| `no_matching_credential` with `audience_mismatch` | Request the token with the credential's **Audience**. |
| `no_matching_credential` with `subject_mismatch` | Copy the `subject` the event recorded into the credential, or fix the job. GitHub jobs with an `environment:` use the environment subject. |
| `no_matching_credential` with `claim_mismatch:<claim>` | The event's `claims` shows the token's value for that claim. |
| `ERR_JWT_EXPIRED` | Request the OIDC token right before the exchange. |
| `lifetime_too_long` | The issuer minted a token valid for more than a day. On Kubernetes, use a projected token with `expirationSeconds` of a day or less. |
| `issuer_keys_unavailable` | Archestra could not read the issuer's discovery document or keys. The issuer must be reachable over https at a public address. |
| `service_account_disabled` | Enable the account under **Settings → Service Accounts**. |
| `matches_several_service_accounts` | A token sent as the Bearer token matched credentials on more than one account. Keep one account's credential for that subject. |
