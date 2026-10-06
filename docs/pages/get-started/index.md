---
title: Get Started
description: Run Archestra, connect your clients, and see your first governed request
order: 1
explore: false
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Three steps take you from nothing to a working setup:

1. **Run Archestra** on your machine. This page.
2. **[Connect your agents](/docs/get-started/connect)**, such as Claude Code or Cursor.
3. **[See it work](/docs/get-started/see-it-work)** in Chat and in the logs.

Already have an agent set up in Claude Code or OpenClaw? [Migrate it](/docs/get-started/migrate) after step 1.

<span id="run-it-locally-to-try"></span>

## Run Archestra

:::quickstart:::

**Next:** [Connect your agents](/docs/get-started/connect).

<span id="pricing"></span>

## Licensing

Archestra is open core. The base platform is licensed under AGPL-3.0. Enterprise features use the Archestra Enterprise License: SSO, custom roles and per-resource permissions, knowledge bases, data retention, content encryption, and two-factor authentication. [`LICENSE.md`](https://github.com/archestra-ai/archestra/blob/main/LICENSE.md) shows which license covers each file.

Enterprise features are free for companies with fewer than 30 users. Archestra turns them on automatically.

- **Who counts:** every person who is invited or can sign in, active or not. See [`LICENSE_ENTERPRISE`](https://github.com/archestra-ai/archestra/blob/main/LICENSE_ENTERPRISE).
- **30 users or more:** production use needs an Enterprise license. Contact sales@archestra.ai, then set [`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED=true`](/docs/reference/configuration#ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED).
