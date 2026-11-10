---
title: Workload Identity Federation
description: Let CI jobs and workloads sign in as a service account with their own OIDC token instead of a stored API key
order: 6
lastUpdated: 2026-11-07
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Let a CI job sign in as a service account with the OIDC token its platform already issues, so no Archestra API key sits in your CI secrets. A GitHub Actions job that deploys from `main` gets a one-hour token; the same workflow run from a pull request gets nothing.

Workload identity federation is an [Enterprise feature](/docs/get-started/pricing-model). To manage an account's federated credentials, you need update access on that service account. See [Granular Access Control](/docs/admin/access-control#granular-access-control).

## When to Use It

Use a federated credential when the workload can get an OIDC token from its platform. Use an [API key](/docs/reference/api#service-accounts) for everything else.

- **GitHub Actions, GitLab CI, Google Cloud, and Kubernetes** issue OIDC tokens. Federate them.
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

A GitHub Actions job that names an `environment:` gets the environment subject, so require the environment instead of the branch when you deploy through one.

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

## What Gets Checked

Each exchange checks the token, then the account's credentials. Any failure refuses the exchange.

- **Signature:** RS256 or ES256, by a key from the issuer's published key set. Archestra fetches it only from an issuer one of the account's credentials names, and only over https from a public address.
- **Lifetime:** the token is not expired or not yet valid, with 30 seconds of clock skew. A token valid for more than 24 hours is refused, however much time it has left.
- **Match:** one credential's issuer, audience, subject, and claim conditions all match the token.
- **Account:** the service account is enabled.

Changing a credential's issuer, audience, subject, or conditions revokes the tokens it already issued, as does deleting it. Disabling the account stops them too.

## Troubleshooting

A refused exchange answers `400` with an `error` code. The **Audit** tab of [Logs and Auditing](/docs/admin/logs) shows why: open the **Service account token exchanged** event for the account and read `reason`.

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
