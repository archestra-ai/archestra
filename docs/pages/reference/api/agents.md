---
title: Agents and Runtime
description: Create agents, choose their tools, and manage skills, plugins, hooks, and scheduled runs
order: 1
lastUpdated: 2026-11-11
---

Create an agent, control the tools it can use, and inspect its runtime activity with these endpoints.

Agent delegation and OpenAPPA operations live here because they act on agent runs. For remote agent-to-agent connections, see [A2A](/docs/reference/api/a2a).

## List a User’s Visible Skills

Use `GET /api/skills?visibleTo=<userId>` to check which skills a user can read, without including skills visible only to you.

```bash
curl -H "Authorization: arch_..." \
  'https://archestra.example.com/api/skills?visibleTo=<userId>&includeContent=false'
```

The request requires skill read access and the **update** action on all skills (`*`). See [Granular Access Control](/docs/admin/access-control#granular-access-control). The target must belong to your current organization.

The response uses the target’s permissions for skills, filters, and pagination. Omit `visibleTo` to list your own visible skills. Insufficient permission returns `403`; a missing user or one outside your organization returns `404`.
