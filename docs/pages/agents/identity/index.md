---
title: Agent Identity
description: Who an agent acts for, whose account each tool call uses, and how to give each agent its own identity at your identity provider
order: 8
lastUpdated: 2026-11-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

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

<span id="microsoft-entra-agent-id"></span>

Pick the guide for your identity provider:

| Identity provider | What the agent is there | Guide |
| --- | --- | --- |
| Microsoft Entra ID | An Entra agent identity, the client of each token | [Microsoft Entra Agent ID](/docs/agents/identity/entra) |
| Okta | An Okta AI agent, the client of each token | [Okta AI Agents](/docs/agents/identity/okta) |
| Keycloak, PingOne, ZITADEL, Auth0, and other RFC 8693 providers | Its own client, named as the actor in each token | [Agent Actor Tokens](/docs/agents/identity/actor-tokens) |
| RFC 8693 providers that trust another issuer's JWTs | A SPIFFE ID Archestra issues, named as the actor; nothing to register per agent | [SPIFFE Agent Identities](/docs/agents/identity/spiffe) |

Each guide ends with binding: on the agent's **Advanced** step (or a gateway's **Settings** tab), under **Identity**, pick the provider under **Identity Provider** and enter the agent's ID there. Tools exchange at that provider unless their MCP server names another. For one that does, add the agent's identity there with **Add an identity at another provider**.

What to know:

- The API still grants the person's access, not less. To limit an agent to part of the data, the API or MCP server must check which agent called.
- Changing an agent's identities takes [`identityProvider:update`](/docs/reference/permissions#identityProvider:update). Each identity binds to one agent only, and cloning or importing an agent does not copy it.
- An agent without an identity at a provider runs as the provider's shared client, unless the provider requires one.

## See Who Did What

Every tool call records the person, the agent, and the account it used. Open a call in the [MCP Gateway logs](/docs/insights/logs): **Identity** shows the account, **Token issued to** shows the app a company-identity token was issued to, along with the acting agent when the token names one.
