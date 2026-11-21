---
title: "Agent Actor Tokens"
description: "Name the agent as the actor in each RFC 8693 token exchange, so downstream tokens carry the person and the agent"
order: 3
lastUpdated: 2026-11-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Give each agent its own client at your identity provider, and every downstream token names the person and the agent. The person stays the subject (`sub`), and the agent is the actor (`act`), as [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693#section-4.1) defines. Use it with Keycloak, PingOne, ZITADEL, Auth0 Custom Token Exchange, or any provider whose token exchange accepts an actor token.

This builds on [IdP token exchange](/docs/mcp/authentication/idp-token-exchange) with RFC 8693. Set that up first. If your identity provider can trust a JWT from another issuer as the actor, [SPIFFE Agent Identities](/docs/agents/identity/spiffe) need no client per agent.

## What Happens on a Tool Call

1. Archestra gets the agent's own access token, with a client credentials grant as the agent's client. One token serves every person the agent acts for, until shortly before it expires.
2. Archestra exchanges the person's token as usual, and sends the agent's token as `actor_token`.
3. Your identity provider decides whether the agent may act for the person, and issues a token with the person in `sub` and the agent in `act`.

What to know:

- Whether `act` appears is your identity provider's policy. A provider that ignores actor tokens issues the same token as without them.
- The exchange still runs as Archestra's own exchange client. The agent appears only as the actor.

## Before You Start

- RFC 8693 token exchange works for your MCP servers. See [IdP Token Exchange](/docs/mcp/authentication/idp-token-exchange#set-up-a-server).
- One key pair for all your agents. Archestra signs as each agent with the private key, and each agent's client holds the public key:

  ```bash
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out agents-key.pem
  openssl pkey -in agents-key.pem -pubout -out agents-key.pub.pem
  ```

## Create a Client for Each Agent

Create one client per Archestra agent at your identity provider. Its client ID is what you bind in Archestra.

1. Create a confidential client that may use the client credentials grant.
2. Set its client authentication to a signed JWT (`private_key_jwt`) with the public key, and note the key ID (`kid`).
3. Allow your identity provider's token exchange to accept this client as an actor, as your provider documents it.

## Turn It On in Archestra

1. Go to **Settings → Identity Providers**, click **Edit** on your provider, and open **Tool Access**.
2. Under **Agent Identities**, paste the private key into **Agent Private Key** and its key ID into **Key ID**.
3. To ask for a scope in each agent's own token, set **Actor Token Scope**.
4. Click **Update Provider**.

The stored key stays hidden. Leave it blank to keep it.

## Bind Agents and Gateways

1. Open an agent's **Advanced** step, or a gateway's **Settings** tab.
2. Under **Identity**, pick your provider under **Identity Provider**, paste the agent's client ID into **Agent client ID**, and click **Save changes**.

To check it works, call a tool on an MCP server that uses IdP token exchange with this provider. Open the call in the [MCP Gateway logs](/docs/insights/logs): **Token issued to** shows the agent's client ID as the acting agent.

## Require an Agent Identity

By default, a tool call from an agent without its own client runs with no actor. To stop that, check **Require an agent identity** under **Agent Identities**. Tool calls without an agent identity then fail, including every App, because Apps cannot be bound.

## Troubleshooting

| What the tool call returns | Fix |
| --- | --- |
| "The identity provider refused the agent's own token: …" | Check the agent's client may use client credentials, holds the public key, and that **Key ID** matches its `kid` |
| An error from the exchange that names the actor | Allow the exchange to accept this agent's client as an actor |
| "This agent is bound to an identity at this identity provider, but the identity provider has no agent identity key" | Set **Agent Private Key** under **Agent Identities** |
| "This identity provider requires every agent to act through its own identity" | Bind the agent, or uncheck **Require an agent identity** |
