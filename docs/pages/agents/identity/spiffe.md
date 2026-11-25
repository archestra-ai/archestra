---
title: "SPIFFE Agent Identities"
description: "Give every agent a SPIFFE ID that Archestra vouches for, so your identity provider can name the agent in each token without a client per agent"
order: 4
lastUpdated: 2026-11-16
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Every agent gets a [SPIFFE ID](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/#spiffe-id) the moment it exists, such as `spiffe://archestra.example.com/agent/<agent ID>`, and your identity provider trusts all of them through one issuer. Downstream tokens then name the person and the agent, as with [Agent Actor Tokens](/docs/agents/identity/actor-tokens), but you register nothing per agent: no client, no key, no binding.

Use it when your identity provider's RFC 8693 token exchange can verify an actor token that is a JWT from another issuer, against that issuer's published keys. When it can only take its own clients' tokens, use [Agent Actor Tokens](/docs/agents/identity/actor-tokens) instead.

## What Happens on a Tool Call

1. Archestra issues the agent a [JWT-SVID](https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md): a five-minute JWT with the agent's SPIFFE ID in `sub`, signed by Archestra.
2. Archestra exchanges the person's token as usual, and sends the JWT-SVID as `actor_token`, of type `urn:ietf:params:oauth:token-type:jwt`.
3. Your identity provider checks the JWT-SVID against Archestra's keys, and issues a token with the person in `sub` and the agent in `act`.

What to know:

- Archestra signs with an ES256 (P-256) key it creates and rotates every 30 days. A replaced key stays published for a day, so verifiers that cache keys keep working.
- Your identity provider must accept ES256 tokens from another issuer. AWS IAM does. Microsoft Entra workload identity federation takes RS256 only, so it can't verify a JWT-SVID.
- Whether `act` appears is your identity provider's policy, as with any actor token.

## Before You Start

- RFC 8693 token exchange works for your MCP servers. See [IdP Token Exchange](/docs/mcp/authentication/idp-token-exchange#set-up-a-server).
- Your identity provider can reach Archestra's public URL, to read its keys.

## Trust Archestra's Issuer

Your identity provider needs to know where Archestra publishes its keys. Every value is on the provider's **Tool Access** tab in Archestra once you pick SPIFFE.

1. Go to **Settings → Identity Providers**, click **Edit** on your provider, and open **Tool Access**.
2. Under **Agent Identities**, set **Agent Identity** to **SPIFFE ID (JWT-SVID)**.
3. At your identity provider, trust the **Issuer** shown there for actor tokens. A provider that takes an OIDC issuer finds the keys through its discovery document. One that takes a key set URL uses **JWKS URL**.
4. To address each JWT-SVID to another audience than your provider's issuer, set **JWT-SVID Audience** to the value your provider expects.
5. Click **Update Provider**.

Every agent and MCP Gateway that exchanges at this provider now acts as its SPIFFE ID. When this is an agent's **Identity Provider**, its **Identity** section shows the ID, ready to copy into your provider's policies.

To check it works, call a tool on an MCP server that uses IdP token exchange with this provider. Open the call in the [MCP Gateway logs](/docs/insights/logs): **Token issued to** shows the agent's SPIFFE ID as the acting agent.

## Federate With SPIRE

A SPIRE server can trust your agents' trust domain like any other. Point its federation at the **SPIFFE bundle** URL with the `https_web` profile. To pick the trust domain, set [`ARCHESTRA_AGENT_IDENTITY_SPIFFE_TRUST_DOMAIN`](/docs/admin/deployment/configuration#ARCHESTRA_AGENT_IDENTITY_SPIFFE_TRUST_DOMAIN). Changing it changes every agent's SPIFFE ID.

## Require an Agent Identity

Every agent has a SPIFFE ID, so the setting only affects tool calls no agent makes. Check **Require an agent identity** to refuse those, including every App's.

## Troubleshooting

| What the tool call returns | Fix |
| --- | --- |
| An error from the exchange about the actor token or its issuer | Trust the **Issuer** at your identity provider for actor tokens, and check it can reach the **JWKS URL** |
| An error about the token's audience | Set **JWT-SVID Audience** to the audience your identity provider expects |
| "This identity provider requires every agent to act through its own identity" | The call came from an App. Uncheck **Require an agent identity**, or make the call from an agent |
