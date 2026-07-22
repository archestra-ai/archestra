---
title: "API Reference"
category: Archestra Platform
description: "Interactive API documentation for Archestra"
order: 6
lastUpdated: 2026-07-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Explore the Archestra API using the interactive documentation below.

## Authentication

Use a personal API key or service account token in the `Authorization` header.

### Personal API Keys

Personal API keys are owned by one user. Create them in the API Keys section on **Your Account** — click your name in the sidebar. They use the owner's current role, so permission changes to that user immediately affect the key.

Use personal keys for local scripts, development tools, and user-owned automation.

### Service Accounts

Service accounts are organization-owned identities for automation. Create them
from **Settings → Service Accounts**, assign a role, and create an API key.

Service account requests authorize from the service account's assigned role.
Disable or delete the service account to stop all of its keys, or delete an
individual key when rotating credentials.

Use service accounts for CI, scheduled jobs, shared integrations, and production
automation that should not depend on an individual user remaining active.

:::swagger-ui
:::
