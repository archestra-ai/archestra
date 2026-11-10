---
title: Agent Identity
description: Who an agent acts for, whose account each tool call uses, and how to give an agent its own Microsoft Entra identity
order: 8
lastUpdated: 2026-11-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

An agent always acts for someone, and every tool call signs in as a real account. Ask an agent to file a Jira ticket, and Jira shows your name, while the logs show which agent filed it. Nobody shares one bot key that can do everything.

## Who an Agent Acts For

An agent runs as whoever called it, and gets only what that caller can use:

- **A person:** in Chat, from a coding agent, or with their personal token.
- **A team, the organization, or a service account:** with its token. These have no person behind them, so per-person tools do not work.
- **A person from your identity provider:** over A2A, with their company JWT. Pick the provider under **Identity** on the agent's **Advanced** step.

See [A2A Authentication](/docs/agents/triggers-and-channels/webhook-a2a#authentication) for every token an agent accepts.

## Whose Account Each Tool Uses

Each tool acts as the person who asked, or as one shared account. A Jira tool should file tickets as you; a deploy tool can run as a bot. You set this per tool, and the server decides how Archestra signs in. See [Whose Account a Call Uses](/docs/mcp/authentication/servers#whose-account-a-call-uses).

With [IdP token exchange](/docs/mcp/authentication/idp-token-exchange), nobody installs anything: Archestra trades the person's company sign-in for a token the server accepts.

## Give Each Agent Its Own Identity

Your identity provider can register each agent as an identity of its own, so it can tell your agents apart. Each downstream token then names the person and the agent that acted for them. Revoke one agent's access in your identity provider, and only that agent stops.

What to know:

- The API still grants the person's access, not less. To limit an agent to part of the data, the API or MCP server must check which agent called.
- Changing an agent's identity takes [`identityProvider:update`](/docs/reference/permissions#identityProvider:update).

### Microsoft Entra Agent ID

Archestra supports agent identities from Microsoft Entra. Need them from another identity provider? [Open a GitHub issue](https://github.com/archestra-ai/archestra/issues/new/choose) and tell us which one.

1. Set up [Microsoft Entra Agent ID](/docs/admin/identity/entra-agent-id) on your identity provider.
2. On the agent's **Advanced** step, under **Identity**, paste the agent identity's ID into **Entra agent identity app ID**, and click **Save changes**.

## See Who Did What

Every tool call records the person, the agent, and the account it used. Open a call in the [MCP Gateway logs](/docs/admin/logs): **Identity** shows the account, and **Token issued to** shows the app a company-identity token was issued to.
