---
title: Secret Rotation
description: Change each secret Archestra uses, and know who gets signed out and what must be redone
order: 7
lastUpdated: 2026-11-09
---

Every secret Archestra holds can be changed, and this page says how, or links the page that does. Most change with one restart or one click, and nobody notices. Two need care: the encryption keys make stored credentials or chat history unreadable if you change them out of order, and the session secret signs every user out.

Archestra's secrets fall into four groups:

- **[Platform keys](#platform-keys):** set when you deploy, such as the session secret and the encryption keys.
- **[Credentials in the app](#credentials-in-the-app):** provider keys, virtual keys, tokens, and OAuth clients that people create in Archestra.
- **[Identity provider secrets](#identity-provider-secrets):** the client secrets and certificates that connect your identity provider.
- **[Integration secrets](#integration-secrets):** tokens for other services that you set as environment variables.

## Platform Keys

These keys protect Archestra itself. Change one when it leaks, when someone who knew it leaves, or on your own schedule.

### Change a Platform Secret

A secret you set in the Helm values takes effect with `helm upgrade`: the chart rolls the web and worker pods when one changes. That covers values under `archestra.env`, `archestra.authSecret.extraData`, and the external database URL.

The chart also generates the session secret, the encryption key, the legacy combined secret, and the Guardrails signing key once, and keeps them in the `<release>-auth` Secret across upgrades. To change one, write a new value into that Secret, then restart the pods. They read secrets only at startup:

```bash
kubectl -n archestra patch secret archestra-platform-auth --type merge \
  -p "{\"stringData\":{\"session-secret\":\"$(openssl rand -base64 48)\"}}"
kubectl -n archestra rollout restart \
  deployment/archestra-platform deployment/archestra-platform-worker
```

- The generated keys are `session-secret`, `secrets-encryption-secret`, `auth-secret`, and `offer-signing-secret`. A value for the same secret under `archestra.env` overrides the generated one.
- Secrets the chart does not manage need the same restart, or a controller that restarts pods when a Secret changes. These are `archestra.authSecret.existingSecretName`, Secrets loaded through `envFromSecrets` or `envWithValueFrom`, and Secrets synced from a cloud secret manager.
- Outside Helm, change the environment variable and restart the container.

### Session Secret

[`ARCHESTRA_AUTH_SESSION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_SESSION_SECRET) signs sign-in sessions and encrypts each user's authenticator secret for two-factor authentication. Change it when you suspect a session was stolen or the value leaked.

When it changes:

- Every user is signed out and signs in again.
- Authenticator codes stop working. Each user with two-factor authentication signs in with a backup code, then turns **Two-factor** off and on again under **Personal Settings → Sign-in & security**. A user without backup codes needs [the reset script](/docs/admin/identity/account-security) with `--disable-two-factor`.
- Coding agents connected through [Connect Your Agents](/docs/get-started/connect) keep working, but stop picking up instruction and helper updates. Run setup again in each client to resume them.

API keys and MCP gateway OAuth tokens keep working. Archestra replaces its token-signing key on startup and keeps publishing the old one, so tokens issued earlier still verify.

### Credential Encryption Key

[`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET) encrypts the API keys and tokens Archestra stores in PostgreSQL. Changed out of order, those credentials become unreadable and must be entered again. Follow [Key Rotation](/docs/admin/deployment/secret-storage#key-rotation).

### Content Encryption Key

[`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET) encrypts LLM Logs, chat messages, and tool results. Content cannot be entered again, so keep the old key until a second run of the sweep rewrites nothing. Follow [Rotating the Key](/docs/admin/content-encryption#rotating-the-key).

### Legacy Combined Secret

[`ARCHESTRA_AUTH_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_SECRET) stands in for the session secret and the credential encryption key when either is unset. The Helm chart sets both, so there it is only the default for [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS). Make it unused before you change it:

1. Move every stored credential to the current encryption key:

   ```bash
   kubectl -n archestra exec deploy/archestra-platform -- \
     sh -c 'cd /app/backend && node dist/standalone-scripts/reencrypt-secrets.mjs'
   ```

   Go on only when it prints `unreadable=0` or `nothing to re-encrypt`.

2. Point the previous key at the current one, so the combined secret is no longer read. Keep this setting:

   ```yaml
   archestra:
     envWithValueFrom:
       - name: ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS
         valueFrom:
           secretKeyRef:
             name: archestra-platform-auth
             key: secrets-encryption-secret
   ```

3. Run `helm upgrade`, then change `auth-secret` as in [Change a Platform Secret](#change-a-platform-secret).

Users stay signed in and stored credentials stay readable.

### Guardrails Signing Key

[`ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET) signs Guardrails delegation between agents and agent-to-agent messages. Change `offer-signing-secret` when few agents are running.

- Agent runs in progress, and messages between agents that are not yet read, can be refused after the change. Start those runs again.
- Without a dedicated value, the key derives from the session secret and changes with it. The Helm chart always sets one.

### Default Admin Password

[`ARCHESTRA_AUTH_ADMIN_PASSWORD`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_ADMIN_PASSWORD) only sets the admin's password when Archestra creates that user on an empty database. Changing it later does nothing on its own.

1. Sign in as the admin, go to **Personal Settings → Sign-in & security**, and click **Change** next to **Password**. This signs the admin out everywhere else. If you cannot sign in, use [the reset script](/docs/admin/identity/account-security) with `--email` and `--password`.
2. Set the variable to the new password, so a restore into an empty database does not bring back the old one.

### Metrics Token

[`ARCHESTRA_METRICS_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_METRICS_SECRET) is the bearer token Prometheus sends to read `/metrics`. Archestra accepts one token at a time, so change it on Archestra and on every scraper together. Scrapes return HTTP `401` until both sides match, which leaves a short gap in your metrics.

### Encrypted Chat Escrow Key

[`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/admin/deployment/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY) applies only to [encrypted chats](/docs/chat#encrypted-chats) created after the change. Older chats stay escrowed to the old key, so keep its private key while those chats exist. Each escrowed chat key records the fingerprint of the public key it used, so recovery operators can tell which private key opens it.

## Credentials in the App

People create these in Archestra, and replace them there. None needs a restart.

| Credential | Where | How to replace it |
| --- | --- | --- |
| [Provider API key](/docs/llm-proxy/providers#with-an-api-key) | **Model Providers** | **Edit** the key and paste the new value under **API Key**. Clients keep their virtual keys. |
| [Subscription](/docs/llm-proxy/providers#with-a-subscription) | **Model Providers** | Sign in again when the card says the sign-in expired. |
| [Virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) | **LLM Proxy** | Create a new key, move the app to it, then delete the old one. |
| [Gateway token](/docs/mcp/authentication/gateway#platform-token) | Your name in the sidebar, **Settings → Teams**, or **Settings → Auth** | Click **Rotate Token**. The old token stops working. |
| [OAuth client secret](/docs/mcp/authentication/applications) | **Settings → OAuth Clients** | Click **Rotate secret**. The old secret stops working at once, so update the app right away. |
| [API key or service account key](/docs/reference/api#authentication) | **API Keys** | Create a new key, move your clients to it, then delete the old one. |
| [Workload identity](/docs/admin/identity/workload-identity) | **Settings → Service Accounts** | Nothing to rotate: each token expires after one hour. |
| [MCP server or agent credential](/docs/admin/credentials#replace-or-disconnect-a-value) | **Credentials** | Replace the value, then restart MCP servers that read it as a static secret. |
| [Knowledge connector credential](/docs/knowledge/connectors) | The connector's **Edit** dialog | Enter the new credential. For Salesforce, rotate the consumer secret in the app and the connector together. |
| [Messaging channel](/docs/agents/triggers-and-channels) | **Settings → Messaging Channels** | Open the channel's setup and enter the new token or secret. |

## Identity Provider Secrets

Your identity provider issues these, so a change starts there. Update Archestra before the old value expires, or sign-in fails.

- **OIDC client secret:** create a new secret at the identity provider. In **Settings → Identity Providers**, edit the provider and enter it. A blank field keeps the stored value.
- **SAML certificate:** download the identity provider's new metadata and update the certificate on the same page. An old certificate fails sign-in with `signature_validation_failed`, as [SSO troubleshooting](/docs/admin/identity/sso#troubleshooting) shows.
- **Entra On-Behalf-Of:** the OBO exchange uses the same provider's client secret. Rotate it the same way. See [Microsoft Entra ID](/docs/admin/identity/entra-obo).

## Integration Secrets

Provider API keys, ChatOps tokens, the Vault token, object storage keys, OAuth client secrets, and OTLP passwords that you set as environment variables belong to another service. Rotate them there.

1. Create the new value at the provider.
2. Set it in Archestra and restart, as in [Change a Platform Secret](#change-a-platform-secret).
3. Revoke the old value once the pods are on the new one.

- If the provider revokes the old value the moment it issues a new one, requests to it fail until the restart finishes.
- For the Google Drive OAuth client, a new [`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET) needs no reconnect. A new client ID makes every connector that uses it reconnect.
- Archestra picks up a rotated token in [`ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE`](/docs/admin/deployment/configuration#ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE) without a restart.
