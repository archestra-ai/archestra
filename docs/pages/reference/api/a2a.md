---
title: A2A
description: Connect Archestra agents to remote agents and manage agent-to-agent communication
order: 2
lastUpdated: 2026-11-04
---

Connect Archestra agents to remote A2A agents and manage the resulting agent-to-agent communication.

## Authentication

For `/v1/a2a/*` and `/v2/a2a/*`, send `Authorization: Bearer <credential>`. Agent calls accept platform tokens, service account API keys, OAuth access tokens with `a2a` scope, or JWTs from the agent's configured identity provider. The authenticated account must have access to the agent. See [A2A Authentication](/docs/agents/triggers-and-channels/webhook-a2a#authentication) for credential options and [OAuth Clients](/docs/mcp/authentication/applications) for application setup.

Agent discovery at `GET /v2/a2a/agents` accepts platform tokens only. The `/api/a2a/remote-agents` management routes use [REST API authentication](/docs/reference/api#authentication) to register and configure remote agents.
