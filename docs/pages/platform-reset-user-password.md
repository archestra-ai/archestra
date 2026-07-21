---
title: "Password Reset"
category: Administration
description: "Reset any user's password from the shell when there is no email-based recovery"
order: 5
lastUpdated: 2026-07-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra has no email provider, so there is no self-service "forgot password" link. Password recovery is a shell operation: an operator with access to the backend container resets any user's password with a bundled command-line tool. This is the path behind the sign-in page's "ask an administrator to reset it".

The tool matches a user by email, sets a new password, and signs that user out everywhere. It can also clear a lost second factor. Access is controlled by shell and database access to the deployment — there is no in-app role for it, and it needs no running server.

## When You Need It

- A member forgot their password and asks an administrator to reset it.
- An administrator is locked out — single sign-on broke and they have no usable password — and needs to recover, then re-enable basic auth.
- A user lost their two-factor device and cannot complete sign-in.

## Running the Tool

The tool ships compiled inside the platform image at `/app/backend`. It needs the database connection string in its environment (`ARCHESTRA_DATABASE_URL` or `DATABASE_URL`), the same as the server. How you supply that depends on how you deployed.

**Helm or external-database Docker** — the database URL is already in the pod or container environment, so run the tool directly:

```bash
kubectl exec -it deploy/archestra-platform -- \
  sh -c 'cd /app/backend && node dist/standalone-scripts/reset-user-password.mjs --email user@example.com'
```

**All-in-one quickstart image (bundled PostgreSQL)** — the database URL is not exported to an `exec` shell, so pass it explicitly. Use the connection string for the bundled database:

```bash
docker exec -it <container> sh -c 'cd /app/backend && \
  ARCHESTRA_DATABASE_URL=postgresql://user:password@localhost:5432/database \
  node dist/standalone-scripts/reset-user-password.mjs --email user@example.com'
```

Omit `--password` and the tool generates a strong random password and prints it once. It is not stored anywhere else, so copy it before closing the shell. The user should sign in and change it on Your Account — click your name in the sidebar.

## Options

| Option | Description |
| --- | --- |
| `--email <email>` | Required. The email of the user whose password to reset. |
| `--password <password>` | The new password (8–128 characters). Omit it to generate and print a random one. |
| `--disable-two-factor` | Also remove the user's two-factor enrollment, to recover a user who lost their device. |
| `--help` | Print usage and exit. |

## What It Does

Every run does the following in a single database transaction, so a crash mid-reset rolls back cleanly:

- Sets the new password. If the user signed in only through SSO and has no email/password account yet, the tool creates one so they can sign in with the new password.
- Revokes every one of the user's sessions, so anyone holding a session under the old password loses it.
- With `--disable-two-factor`, removes the user's two-factor enrollment.

Each reset is written to the user's organization audit log as a `user.password_reset` action, attributed to the CLI.

Two conditions the tool reports but does not change:

- A **banned** user still cannot sign in until an administrator unbans them.
- When `ARCHESTRA_AUTH_DISABLE_BASIC_AUTH` is set, email/password sign-in is off, so the new password only works after basic auth is re-enabled.

## Recovering a Locked-Out Administrator

If you disabled basic auth and single sign-on later breaks, every administrator can be locked out. Recover from the shell:

1. Reset an administrator's password with the tool above.
2. Re-enable email/password sign-in by unsetting `ARCHESTRA_AUTH_DISABLE_BASIC_AUTH` (see [Deployment — Environment Variables](/docs/platform-deployment#environment-variables)).
3. Sign in with the new password and fix the SSO configuration.

To avoid this, verify at least one SSO provider works before you disable basic auth. See [SSO](/docs/platform-sso).

## Use Case

Acme runs Archestra for its data team.

A member, Jordan, forgets their password. Jordan asks an administrator to reset it. The administrator opens a shell on the backend container and runs the tool with `--email jordan@acme.example`, leaving off `--password`. The tool prints a random password, which the administrator shares with Jordan over a secure channel. Jordan signs in, changes the password on Your Account, and the earlier sign-in attempts are already dead because every session was revoked.

Months later Acme enables SSO and sets `ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`. The identity provider's certificate expires over a weekend, and no administrator can sign in. An operator with cluster access runs the tool against their own account, unsets `ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`, signs in with the printed password, and renews the SSO certificate. Once SSO works again, they re-disable basic auth.
