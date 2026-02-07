---
title: "API Reference"
category: Archestra Platform
description: "Interactive API documentation for the Archestra Platform"
order: 9
lastUpdated: 2025-01-10
---

Explore the Archestra Platform API using the interactive documentation below. You can view all available endpoints, request/response schemas, and try out API calls directly.

## Authentication

To authenticate with the Archestra Platform API, you'll need an API key:

1. Log in to the Archestra Admin UI (default: <http://localhost:3000>)
2. Navigate to **Settings** → **Account**
3. In the **API Keys** section, click **Create API Key**
4. Copy the generated key — it will only be shown once

Include the API key in your requests using the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://localhost:9000/api/agents
```

:::swagger-ui
:::
