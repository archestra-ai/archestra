---
title: "Microsoft Entra ID"
description: "Sign people in with Microsoft Entra ID, and let MCP tools call Microsoft Graph and your APIs as each person with On-Behalf-Of"
order: 2
lastUpdated: 2026-11-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Sign people in with their Microsoft accounts, then let MCP tools call Microsoft Graph and your own APIs as each person. Ask an agent to read your calendar, and Graph sees you, with your permissions, not a shared service account. On every tool call, Archestra uses Entra's [On-Behalf-Of](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow) exchange to trade the person's sign-in token for a token to the API, so nobody pastes a token.

Set up sign-in first. Continue with On-Behalf-Of only if MCP tools need to call APIs as each person.

<span id="1-register-the-entra-application"></span>

## Register the Entra Application

Register one app for Archestra. It signs people in and runs the exchange.

1. In the Microsoft Entra admin center, go to **Identity → Applications → App registrations** and click **New registration**.
2. Set **Name** to `Archestra`.
3. Set **Supported account types** to **Accounts in this organizational directory only (Single tenant)**.
4. Set **Redirect URI** to **Web** and enter `https://<archestra-domain>/api/auth/sso/callback/EntraID`.
5. Click **Register**. Note the **Application (client) ID** and **Directory (tenant) ID**.
6. Under **Certificates & secrets**, click **New client secret**, then copy the secret **Value**.
7. Under **API permissions**, add **Microsoft Graph → Delegated permissions → `User.Read`**, and click **Grant admin consent**.

<span id="2-configure-sso-in-archestra"></span>

## Configure SSO in Archestra

Connect the app to Archestra, so people can sign in with their Microsoft accounts.

1. Go to **Settings → Identity Providers** and click **Configure** on **Microsoft Entra ID**.
2. Replace `{tenant-id}` in the pre-filled URLs with your Directory (tenant) ID.
3. Paste the **Client ID** and **Client Secret**.
4. Keep `openid`, `profile`, and `email` in **Scopes**. Add `offline_access` so sign-in can refresh in the background.
5. Click **Create Provider**.

To check it works, open Archestra in a private window and click **Sign in with EntraID**.

<span id="3-map-roles-and-sync-teams"></span>

## Map Roles and Sync Teams

Turn Entra app roles and groups into Archestra roles and teams:

- **Roles:** map Entra app roles or groups to Archestra roles. See [Role Mapping](/docs/admin/identity/sso#role-mapping).
- **Teams:** in Entra's **Token configuration**, add a **Groups claim**, then link teams to Entra group IDs. See [Team Sync](/docs/admin/identity/sso#team-sync).

<span id="4-configure-entra-for-on-behalf-of-obo"></span><span id="configure-entra-for-on-behalf-of-obo"></span>

## Configure Entra for On-Behalf-Of

On-Behalf-Of trades the token a person signed in with for a token to a downstream API, such as Microsoft Graph or your own. Entra requires the sign-in token to be addressed to the Archestra app, so the app exposes a scope of its own.

1. In the Entra app registration, open **Expose an API**.
2. Click **Add** next to **Application ID URI** and accept `api://<client-id>`.
3. Click **Add a scope**, name it `access_as_user`, set **Who can consent** to **Admins and users**, and click **Add scope**.
4. Under **Authorized client applications**, click **Add a client application**, paste this app's own client ID, check the `access_as_user` scope, and click **Add application**.
5. Under **API permissions**, add the delegated permissions your tools need, such as `Mail.Read`, and click **Grant admin consent**.

<span id="5-enable-obo-in-archestra"></span><span id="enable-obo-in-archestra"></span>

## Enable On-Behalf-Of in Archestra

Tell Archestra where to run the exchange, and ask for the app's own scope at sign-in.

1. In **Settings → Identity Providers**, click **Edit** on **Microsoft Entra ID**.
2. Under **OIDC Settings**, add `api://<client-id>/access_as_user` to **Scopes**.
3. Open **Tool Authentication** and set:
   - **Exchange Token Endpoint:** `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`
   - **Exchange Client Authentication:** **Client secret POST**
   - **User's Token to Exchange:** **Access token**
4. Click **Update Provider**.

People who signed in before you added the scope must sign in again, so their token carries it.

<span id="6-configure-mcp-server-multitenant-auth"></span><span id="configure-mcp-server-multitenant-auth"></span>

## Use It in an MCP Server

Pick **IdP token exchange** on the server, and set **Managed Resource Identifier** to the API: `https://graph.microsoft.com` for Graph, or `api://<api-client-id>` for your own. See [IdP Token Exchange](/docs/mcp/authentication/idp-token-exchange#set-up-a-server).

To check it works, call one of the server's tools, then open the call in the [MCP Gateway logs](/docs/admin/logs): **Token issued to** shows **Identity provider's client**.

Every agent's calls reach the API as that one app. To have Entra tell your agents apart, give each one its own identity with [Microsoft Entra Agent ID](/docs/admin/identity/entra-agent-id). To give one server its own app, see [Give a Server Its Own Exchange Client](/docs/mcp/authentication/idp-token-exchange#give-a-server-its-own-exchange-client).

## Troubleshooting

| What you see | Fix |
| --- | --- |
| Tool call returns `AADSTS65001` (no consent) | Grant admin consent for the API's scope to the app the error names |
| Tool call returns `AADSTS50013` (signature could not be validated) | The sign-in token was issued for Microsoft Graph. Add `api://<client-id>/access_as_user` to **Scopes**, then sign in again. |
