---
title: "Okta AI Agents"
description: "Give each agent its own Okta AI agent, so Okta's delegation rules and logs apply per agent"
order: 2
lastUpdated: 2026-11-14
beta: "Preview. Okta for AI Agents is in early access at Okta, and your Okta plan must include it."
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Give every agent its own AI agent in Okta, so Okta can tell your agents apart. Okta then decides which people each agent may act for and which resources it may reach, and its System Log names the agent on every token. Deactivate one AI agent in Okta, and only that agent stops.

This builds on [Okta token exchange](/docs/admin/identity/okta#configure-okta-for-token-exchange). Set that up first. Without AI agents, every agent's tool calls reach downstream APIs as Archestra's Okta app.

## What Downstream APIs See

Each tool call runs the token exchange as the calling agent's own Okta client, on the person's behalf. Okta issues the token to the AI agent, with the person as the subject, so the API and Okta's logs see both.

The token exchange depends on what the MCP server asks for:

- **A bearer token or a secret:** one exchange at your Okta org, as the agent.
- **An ID-JAG:** Okta issues an [ID-JAG](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/) to the agent, and Archestra trades it at the resource's authorization server, as the agent again.

## Before You Start

- [Okta token exchange](/docs/admin/identity/okta#enable-token-exchange-in-archestra) works for your MCP servers.
- Your Okta org has Okta for AI Agents.
- One key pair for all your agents. Archestra signs as each agent with the private key, and each AI agent holds the public key:

  ```bash
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out agents-key.pem
  openssl pkey -in agents-key.pem -pubout -out agents-key.pub.pem
  ```

## Register an AI Agent for Each Agent

Register one AI agent per Archestra agent. Its client ID, which starts with `wlp`, is what you bind in Archestra.

1. In the Okta Admin Console, register an AI agent with a new OIDC client, and assign it an owner.
2. Add the public key to the AI agent's client credentials, and note its key ID (`kid`).
3. Activate the AI agent. Okta refuses a staged agent's client ID.
4. Link the AI agent to Archestra's Okta app, so Okta accepts the person's ID token from Archestra's sign-in.
5. Give the AI agent a connection to each resource it calls, such as the authorization server of an MCP server that takes an ID-JAG.

## Turn It On in Archestra

1. Go to **Settings → Identity Providers**, click **Edit** on **Okta**, and open **Tool Access**.
2. Under **Agent Identities**, paste the private key into **Agent Private Key** and its key ID into **Key ID**.
3. Click **Update Provider**.

The stored key stays hidden. Leave it blank to keep it.

## Bind Agents and Gateways

1. Open an agent's **Advanced** step, or a gateway's **Settings** tab.
2. Under **Identity**, pick Okta under **Identity Provider**, paste the AI agent's client ID into **Okta AI agent client ID**, and click **Save changes**.

To check it works, call a tool on an MCP server that uses [IdP token exchange](/docs/mcp/authentication/idp-token-exchange) with Okta. Open the call in the [MCP Gateway logs](/docs/insights/logs): **Token issued to** shows **Okta AI agent** and its client ID.

## Require an Agent Identity

By default, a tool call from an agent without an AI agent runs as Archestra's Okta app. To stop that, check **Require an agent identity** under **Agent Identities**. Tool calls without an agent identity then fail, including every App, because Apps cannot be bound.

## Troubleshooting

| What the tool call returns | Fix |
| --- | --- |
| `invalid_client` | Check the AI agent is active, holds the public key, and that **Key ID** matches its `kid` |
| An Okta error that the subject token's client is not allowed | Link the AI agent to Archestra's Okta app |
| An Okta error that names no connection or resource | Give the AI agent a connection to that resource |
| "This agent is bound to an identity at this identity provider, but the identity provider has no agent identity key" | Set **Agent Private Key** under **Agent Identities** |
| "This identity provider requires every agent to act through its own identity" | Bind the agent, or uncheck **Require an agent identity** |
