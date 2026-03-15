---
title: "API Reference"
category: Archestra Platform
description: "Interactive API documentation for Archestra"
order: 9
lastUpdated: 2025-01-10
---

Explore the Archestra API using the interactive documentation below.

## Authentication

To authenticate with the Archestra API, head to the **Settings** → **Authentication** page (`/settings/auth`) to create a personal API key (requires `apiKeys:read` and `apiKeys:create` permissions, see [Access Control](/docs/platform-access-control) for more details).

Once you've created an API key, copy the key (it will only be shown once), and include the key in your requests using the `Authorization` header:

```bash
curl -H "Authorization: YOUR_API_KEY" <your_archestra_hostname>/api/agents
```

:::swagger-ui
:::
