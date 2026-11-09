---
title: "Microsoft Entra Agent ID"
description: "Give each agent its own Microsoft Entra identity, so consent, Conditional Access, and sign-in logs apply per agent"
order: 3
lastUpdated: 2026-11-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Give every agent its own identity in Microsoft Entra, so Entra can tell your agents apart. Revoke one agent's access to an API in Entra, and only that agent stops; the others keep working. Each downstream token names the person and the agent that acted for them.

This builds on [Entra On-Behalf-Of](/docs/admin/identity/entra-obo). Set that up first. Without Agent ID, every agent's tool calls reach downstream APIs as the identity provider's client.

## What Downstream APIs See

Each tool call gets a token issued to the calling agent's [Entra agent identity](https://learn.microsoft.com/entra/agent-id/identity-platform/what-is-agent-id), on the person's behalf. The API sees the person as the user (`oid`) and the agent identity as the client (`azp`), so Entra consent, Conditional Access, and sign-in logs apply per agent.

## Before You Start

- Entra On-Behalf-Of works for your MCP servers. See [Entra On-Behalf-Of](/docs/admin/identity/entra-obo).
- Your tenant has [Microsoft Entra Agent ID](https://learn.microsoft.com/entra/agent-id/).
- An app registration you can call Microsoft Graph as, with these application permissions and admin consent: `AgentIdentityBlueprint.Create`, `AgentIdentityBlueprint.AddRemoveCreds.All`, `AgentIdentityBlueprint.UpdateAuthProperties.All`, `AgentIdentityBlueprintPrincipal.Create`, `AgentIdentity.Create.All`, and `DelegatedPermissionGrant.ReadWrite.All`.

Agent ID calls reject delegated tokens that carry `Directory.AccessAsUser.All`, which includes the Azure CLI's. Get a token as that app instead:

```bash
curl -s https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token \
  -d grant_type=client_credentials \
  -d client_id=<app-id> \
  -d client_secret=<app-secret> \
  -d scope=https://graph.microsoft.com/.default
```

Send it as `Authorization: Bearer <token>` on every call below. Every agent identity needs a sponsor, a person accountable for it: replace `<sponsor-id>` with that user's object ID.

## Create the Blueprint

The blueprint is the Entra app that requests tokens for your agent identities. Create one for Archestra.

1. Create the blueprint and its service principal. The blueprint's `id` and `appId` are the same; call it `<blueprint-id>`.

   ```http
   POST https://graph.microsoft.com/v1.0/applications/microsoft.graph.agentIdentityBlueprint
   OData-Version: 4.0

   {
     "displayName": "Archestra agents",
     "sponsors@odata.bind": ["https://graph.microsoft.com/v1.0/users/<sponsor-id>"],
     "owners@odata.bind": ["https://graph.microsoft.com/v1.0/users/<sponsor-id>"]
   }
   ```

   ```http
   POST https://graph.microsoft.com/v1.0/serviceprincipals/microsoft.graph.agentIdentityBlueprintPrincipal
   OData-Version: 4.0

   { "appId": "<blueprint-id>" }
   ```

2. Expose a scope on the blueprint, so a person's token can be addressed to it. `<scope-id>` is a new GUID you choose.

   ```http
   PATCH https://graph.microsoft.com/v1.0/applications/<blueprint-id>

   {
     "identifierUris": ["api://<blueprint-id>"],
     "api": {
       "requestedAccessTokenVersion": 2,
       "oauth2PermissionScopes": [{
         "id": "<scope-id>", "value": "access_agent", "type": "User", "isEnabled": true,
         "adminConsentDisplayName": "Access agent",
         "adminConsentDescription": "Act through this agent for the signed-in user"
       }]
     }
   }
   ```

3. Give the blueprint a certificate. Keep its private key and SHA-1 thumbprint for Archestra. `<certificate>` is the base64 certificate, without the `BEGIN` and `END` lines.

   ```http
   PATCH https://graph.microsoft.com/beta/applications/<blueprint-id>/microsoft.graph.agentIdentityBlueprint
   OData-Version: 4.0

   { "keyCredentials": [{ "type": "AsymmetricX509Cert", "usage": "Verify", "key": "<certificate>" }] }
   ```

   To test without a certificate, add a client secret instead: `POST https://graph.microsoft.com/v1.0/applications/<blueprint-id>/microsoft.graph.agentIdentityBlueprint/addPassword`.

4. Grant your Archestra sign-in app consent for the blueprint's scope. `clientId` is the sign-in app's service principal, and `resourceId` is the blueprint's:

   ```http
   POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants

   {
     "clientId": "<sign-in-app-service-principal-id>",
     "consentType": "AllPrincipals",
     "resourceId": "<blueprint-service-principal-id>",
     "scope": "access_agent"
   }
   ```

## Create an Agent Identity for Each Agent

Create one agent identity per Archestra agent, and grant it only the APIs that agent needs.

1. Create the agent identity. Its `id` and `appId` are the same; call it `<agent-identity-id>`.

   ```http
   POST https://graph.microsoft.com/beta/serviceprincipals/Microsoft.Graph.AgentIdentity
   OData-Version: 4.0

   {
     "displayName": "Support agent",
     "agentIdentityBlueprintId": "<blueprint-id>",
     "sponsors@odata.bind": ["https://graph.microsoft.com/v1.0/users/<sponsor-id>"]
   }
   ```

2. Grant the agent identity consent for each API it calls. `resourceId` is the API's service principal:

   ```http
   POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants

   {
     "clientId": "<agent-identity-id>",
     "consentType": "AllPrincipals",
     "resourceId": "<api-service-principal-id>",
     "scope": "Mail.Read"
   }
   ```

## Turn It On in Archestra

Point Archestra at the blueprint, so it can request a token for each agent identity.

1. Go to **Settings → Identity Providers**, click **Edit** on **Microsoft Entra ID**, and open **Tool Authentication**.
2. Under **Entra Agent ID**, paste `<blueprint-id>` into **Agent Identity Blueprint Client ID**.
3. Paste the certificate's private key into **Certificate Private Key** and its thumbprint into **Certificate Thumbprint**. To test with a secret, use **Blueprint Client Secret** instead.
4. Click **Update Provider**.

Stored secrets stay hidden. Leave a secret blank to keep it.

## Bind Agents and Gateways

Once a blueprint is set, every agent and MCP Gateway shows **Advanced → Entra agent identity**.

1. Open the agent or gateway, and go to **Advanced → Entra agent identity**.
2. Paste `<agent-identity-id>` into **Agent identity app ID**, and click **Save changes**.

To check it works, call a tool on an MCP server that uses [IdP token exchange](/docs/mcp/authentication/idp-token-exchange). Open the call in the [MCP Gateway logs](/docs/admin/logs): **Token issued to** shows **Entra agent identity** and its ID.

What to know:

- Changing a binding takes [`identityProvider:update`](/docs/reference/permissions#identityProvider:update), because it decides which Entra consents the tool calls run under.
- Each agent identity binds to one agent or gateway only.
- Cloning or importing an agent does not copy its binding.

## Require an Agent Identity

By default, a tool call from an agent without an agent identity runs as the identity provider's client. To stop that, check **Require an agent identity** under **Entra Agent ID**. Tool calls without an agent identity then fail with a message that names the fix. That includes every App, because Apps cannot be bound.

## What to Know

- Revoking an agent identity's consent takes effect when its current token expires, within about an hour.
- A new blueprint certificate can take a few minutes to work in Entra.

## Troubleshooting

| What the tool call returns | Fix |
| --- | --- |
| `AADSTS65001` (no consent) naming your agent identity | Grant that agent identity consent for the API, as in [Create an Agent Identity for Each Agent](#create-an-agent-identity-for-each-agent) |
| `AADSTS65001` naming your sign-in app | Grant your sign-in app consent for the blueprint's scope |
| `AADSTS700027` (certificate not registered) | Check the thumbprint matches the blueprint's certificate. A new certificate can take a few minutes to work. |
| "…blueprint has no client secret or certificate" | Set **Certificate Private Key** or **Blueprint Client Secret** under **Entra Agent ID** |
| "This agent is bound to a Microsoft Entra agent identity, but…" | Set **Agent Identity Blueprint Client ID** on the identity provider |
| "This identity provider requires every agent to act through its own Microsoft Entra agent identity" | Bind the agent, or uncheck **Require an agent identity** |
| An Entra error that names no agent identity of yours | Check **Agent identity app ID** is the agent identity's ID. A wrong ID can fail with an unrelated error, such as `AADSTS50076`. |
