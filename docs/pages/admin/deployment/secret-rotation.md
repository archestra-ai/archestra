---
title: Secret Rotation
description: Change each secret Archestra uses, and know who gets signed out and what must be redone
order: 7
lastUpdated: 2026-11-09
---

Most of Archestra's secrets change with one restart and nobody notices. Two need care. The encryption keys make stored credentials or chat history unreadable if you change them out of order. The session secret signs every user out and resets their authenticator apps. Each section below says what a secret protects, what changes for users, and how to change it.

## Change a Platform Secret

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

## Session Secret

[`ARCHESTRA_AUTH_SESSION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_SESSION_SECRET) signs sign-in sessions and encrypts each user's authenticator secret for two-factor authentication. Change it when you suspect a session was stolen or the value leaked.

When it changes:

- Every user is signed out and signs in again.
- Authenticator codes stop working. Each user with two-factor authentication signs in with a backup code, then turns **Two-factor** off and on again under **Personal Settings → Sign-in & security**. A user without backup codes needs [the reset script](/docs/admin/identity/account-security) with `--disable-two-factor`.
- Coding agents connected through [Connect Your Agents](/docs/get-started/connect) keep working, but stop picking up instruction and helper updates. Run setup again in each client to resume them.

API keys and MCP gateway OAuth tokens keep working. Archestra replaces its token-signing key on startup and keeps publishing the old one, so tokens issued earlier still verify.

## Credential Encryption Key

[`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET) encrypts the API keys and tokens Archestra stores in PostgreSQL. Changed out of order, those credentials become unreadable and must be entered again. Follow [Key Rotation](/docs/admin/deployment/secret-storage#key-rotation).

## Content Encryption Key

[`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET) encrypts LLM Logs, chat messages, and tool results. Content cannot be entered again, so keep both keys until the sweep finishes. Follow [Rotating the Key](/docs/admin/content-encryption#rotating-the-key).

## Legacy Combined Secret

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

## Guardrails Signing Key

[`ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET) signs Guardrails delegation between agents and agent-to-agent messages. Change `offer-signing-secret` when few agents are running.

- Agent runs in progress, and messages between agents that are not yet read, can be refused after the change. Start those runs again.
- Without a dedicated value, the key derives from the session secret and changes with it. The Helm chart always sets one.

## Default Admin Password

[`ARCHESTRA_AUTH_ADMIN_PASSWORD`](/docs/admin/deployment/configuration#ARCHESTRA_AUTH_ADMIN_PASSWORD) only sets the admin's password when Archestra creates that user on an empty database. Changing it later does nothing on its own.

1. Sign in as the admin, go to **Personal Settings → Sign-in & security**, and click **Change** next to **Password**. This signs the admin out everywhere else. If you cannot sign in, use [the reset script](/docs/admin/identity/account-security) with `--email` and `--password`.
2. Set the variable to the new password, so a restore into an empty database does not bring back the old one.

## Metrics Token

[`ARCHESTRA_METRICS_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_METRICS_SECRET) is the bearer token Prometheus sends to read `/metrics`. Archestra accepts one token at a time, so change it on Archestra and on every scraper together. Scrapes return HTTP `401` until both sides match, which leaves a short gap in your metrics.

## Encrypted Chat Escrow Key

[`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/admin/deployment/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY) applies only to [encrypted chats](/docs/chat#encrypted-chats) created after the change. Older chats stay escrowed to the old key, so keep its private key while those chats exist. Each escrowed chat key records the fingerprint of the public key it used, so recovery operators can tell which private key opens it.

## Third-Party Credentials

Provider API keys, ChatOps tokens, the Vault token, object storage keys, OAuth client secrets, and OTLP passwords belong to another service. Rotate them there.

1. Create the new value at the provider.
2. Set it in Archestra and restart, as in [Change a Platform Secret](#change-a-platform-secret).
3. Revoke the old value once the pods are on the new one.

If the provider revokes the old value the moment it issues a new one, requests to it fail until the restart finishes.
