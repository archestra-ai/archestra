---
title: "Two-Factor Authentication"
category: Administration
description: "TOTP-based 2FA for member accounts, organization-wide enforcement, and session lifetime controls"
order: 5
lastUpdated: 2026-07-31
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra supports TOTP-based two-factor authentication: members enroll by scanning a QR code with any authenticator app (1Password, Google Authenticator, Authy, …) and confirming a one-time code. Enrollment generates single-use backup codes for recovery, shown exactly once. Enrolled members are prompted for a code at every sign-in and may trust a device to skip the prompt on it.

Members enroll from **Account → Two-Factor Authentication**. Enrollment (and organization-wide enforcement, below) is an enterprise feature.

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

## Requiring 2FA for the whole organization

**Settings → Organization → Auth → Require Two-Factor Authentication.**

When an admin turns this on:

- Members who have **not** enrolled are signed out immediately (allow up to a minute for every replica to observe the change).
- On their next sign-in they land on the account page, and every API request other than what the enrollment card needs is refused until they finish setup — the requirement is enforced server-side, not just hidden in the UI.
- Members who already have 2FA enrolled keep their sessions and notice nothing.
- The **Settings → Users** table gains a **2FA** column showing who has enrolled and who is still locked out pending setup.

Turning the requirement on (and session lifetime caps, below) requires an enterprise license; the server refuses the setting change without one.

## Session lifetime

**Settings → Organization → Auth → Maximum session lifetime.**

By default, sessions renew on activity — an active member is effectively never signed out. This setting adds an **absolute cap** measured from sign-in: once a session is older than the configured lifetime, it is revoked and the member must sign in again, regardless of activity. Choose a preset (8 hours – 30 days), a custom value, or **No limit** (the default).

## Recovery

A member who loses their authenticator can sign in with one of their single-use backup codes. If those are also lost, an operator can clear the enrollment from the command line — see [Resetting a user's password](/docs/platform-reset-user-password), which covers the `--disable-two-factor` flag. Note that rotating `ARCHESTRA_AUTH_SESSION_SECRET` invalidates all 2FA enrollments (see the [deployment reference](/docs/platform-deployment)).
