---
title: "Account Security"
description: "Two-factor authentication, session lifetime caps, and CLI account recovery"
order: 4
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Enforce two-factor authentication (2FA) and session expiration for email/password accounts, and recover locked-out users from the command line.

Two-factor authentication and organization session policies are enterprise features. See [Pricing Model](/docs/get-started/pricing-model).

## Two-Factor Authentication

<span id="two-factor-authentication"></span>

Members secure password accounts using time-based one-time passwords (TOTP) from any standard authenticator app (1Password, Google Authenticator, Authy).

1. In **Personal Settings** (click your profile in the sidebar), scroll to **Sign-in & security**.
2. Turn on **Two-factor authentication**.
3. Confirm your current password.
4. Scan the QR code in your authenticator app and enter the 6-digit confirmation code.
5. Save your single-use backup recovery codes.

### Organization-Wide 2FA Enforcement

Require all password-authenticated members to enroll in 2FA before accessing the workspace:

1. Go to **Settings → Organization → Auth**.
2. Turn on **Require Two-Factor Authentication**.

When turned on:

- Members without 2FA enrolled are signed out immediately across all replicas.
- On next sign-in, members must complete 2FA enrollment before accessing any API or page.
- The **Settings → Users** table adds a **2FA** column showing member enrollment status.

Deployments with password authentication disabled ([`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH=true`](/docs/reference/configuration#ARCHESTRA_AUTH_DISABLE_BASIC_AUTH)) cannot enforce in-app 2FA. Enforce multi-factor authentication directly at your identity provider instead.

## Session Lifetime Caps

<span id="session-lifetime"></span>

By default, user sessions renew on activity. Set an absolute session lifetime to force re-authentication regardless of user activity:

1. Go to **Settings → Organization → Auth**.
2. Under **Maximum session lifetime**, select a duration preset (8 hours to 30 days) or enter a custom duration.

Once a session exceeds this age from sign-in, Archestra revokes the session and redirects the user to sign in again. Rotating [`ARCHESTRA_AUTH_SESSION_SECRET`](/docs/reference/configuration#ARCHESTRA_AUTH_SESSION_SECRET) immediately invalidates all active sessions.

## Reset a Password from the CLI

<span id="reset-a-password-from-the-cli"></span>

Because Archestra has no outbound email provider, password recovery runs directly against the database from the backend container using a bundled script.

The CLI script updates credentials within a single database transaction, invalidates existing sessions, and writes a `user.password_reset` entry to the audit log.

### Helm or Kubernetes

Run the reset script inside the platform deployment pod:

```bash
kubectl exec -it deploy/archestra-platform -- \
  sh -c 'cd /app/backend && node dist/standalone-scripts/reset-user-password.mjs --email user@example.com'
```

### Docker Quickstart

Pass the database connection URL into the container command:

```bash
docker exec -it <container> sh -c 'cd /app/backend && \
  ARCHESTRA_DATABASE_URL=postgresql://user:password@localhost:5432/database \
  node dist/standalone-scripts/reset-user-password.mjs --email user@example.com'
```

### Script Flags

| Flag | Description |
| --- | --- |
| `--email <email>` | Required. Target user email. |
| `--password <password>` | New password (8–128 characters). If omitted, generates and prints a random password once. |
| `--disable-two-factor` | Clears the user's 2FA enrollment so they can sign in after losing an authenticator device. |
| `--help` | Display command usage. |

## Recovering a Locked-Out Admin

If SSO fails while password authentication is disabled ([`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH=true`](/docs/reference/configuration#ARCHESTRA_AUTH_DISABLE_BASIC_AUTH)), restore access from the cluster:

1. Reset an administrator account password using the CLI script above.
2. In the backend environment, unset [`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`](/docs/reference/configuration#ARCHESTRA_AUTH_DISABLE_BASIC_AUTH) and restart the pod or container.
3. Sign in with the temporary password and correct the SSO identity provider settings.
4. Re-enable [`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH=true`](/docs/reference/configuration#ARCHESTRA_AUTH_DISABLE_BASIC_AUTH) once verified.
