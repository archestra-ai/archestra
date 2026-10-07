---
title: "Microsoft Entra ID"
description: "Configure Microsoft Entra ID for SSO sign-in and On-Behalf-Of token exchange for MCP tools"
order: 2
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect Microsoft Entra ID to sign users in with Microsoft accounts and run MCP tools with per-user Graph and API permissions using On-Behalf-Of (OBO) token exchange.

For sign-in alone, complete sections 1–3. For per-user tool access, complete sections 4–6.

## 1. Register the Entra Application

1. In the Microsoft Entra admin center, go to **Identity → Applications → App registrations** and click **New registration**.
2. Set **Name** to `Archestra`.
3. Set **Supported account types** to **Accounts in this organizational directory only (Single tenant)**.
4. Set **Redirect URI** to **Web** and enter your callback URL:
   `https://<archestra-domain>/api/auth/sso/callback/EntraID`
   *(For local testing: `http://localhost:3000/api/auth/sso/callback/EntraID`)*
5. Click **Register**. Note the **Application (client) ID** and **Directory (tenant) ID**.
6. Under **Certificates & secrets**, click **New client secret**, name it, click **Add**, and copy the secret **Value**.
7. Under **API permissions**, click **Add a permission → Microsoft Graph → Delegated permissions**, check `User.Read`, and click **Grant admin consent**.

## 2. Configure SSO in Archestra

1. In Archestra, navigate to **Settings → Identity Providers** and click **Enable** on **Microsoft Entra ID**.
2. Replace `{tenant-id}` in the pre-filled URLs with your Entra Directory (tenant) ID.
3. Paste your **Client ID** and **Client Secret**.
4. Confirm **Scopes** contains `openid`, `profile`, and `email`. Add `offline_access` to enable background token refresh.
5. Optional: Set **Allowed Email Domains** (e.g. `company.com`).
6. Click **Create Provider**.

Test sign-in in an incognito window using your Microsoft credentials.

## 3. Map Roles and Sync Teams

Configure how Entra claims map to Archestra roles and teams:

- **Role Mapping:** Map Entra app roles or directory groups to Archestra roles. See [Role Mapping](/docs/admin/identity/sso#role-mapping).
- **Team Sync:** In Entra's **Token configuration**, add a **Groups claim** (`Group ID` or `sAMAccountName`). In Archestra, link teams to Entra group IDs under **Settings → Teams**. See [Team Sync](/docs/admin/identity/sso#team-sync).

If your deployment only requires sign-in, setup is complete.

## 4. Configure Entra for On-Behalf-Of (OBO)

OBO allows Archestra to swap the user's login access token for a token scoped to downstream APIs (like Microsoft Graph, SharePoint, or internal APIs).

1. In the Entra app registration, open **Expose an API**.
2. Click **Add** next to **Application ID URI** and accept `api://<client-id>`.
3. Click **Add a scope**:
   - **Scope name:** `access_as_user`
   - **Who can consent:** **Admins and users**
   - **Admin consent display name:** `Access Archestra on user's behalf`
   - Click **Add scope**.
4. Under **Authorized client applications**, click **Add a client application**:
   - Paste the **Application (client) ID** of this same app registration.
   - Check the `api://<client-id>/access_as_user` scope and click **Add application**.
5. Under **API permissions**, add delegated scopes for any downstream APIs the MCP tools will call (such as `Mail.Read` or `Calendars.Read`), then click **Grant admin consent**.

## 5. Enable OBO in Archestra

1. In **Settings → Identity Providers**, edit **Microsoft Entra ID** and expand **Enterprise-Managed Credentials**.
2. Under **Scopes**, ensure `access_as_user` is included:
   `openid profile email offline_access api://<client-id>/access_as_user`
3. Set **Exchange Token Endpoint** to:
   `https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token`
4. Set **Exchange Client Authentication** to **Client secret POST**.
5. Set **User Token To Exchange** to **Access token**.
6. Save the provider.

## 6. Configure MCP Server Multitenant Auth

Enable per-user downstream credentials on target MCP servers:

1. In **MCP Servers**, edit the target catalog entry and open **Multitenant Authorization**.
2. Select **Identity Provider Token Exchange** and pick **Microsoft Entra ID**.
3. Set **Requested Credential** to **Bearer token** and **Injection Mode** to **Authorization: Bearer**.
4. Set **Managed Resource Identifier** to the downstream audience:
   - Microsoft Graph: `https://graph.microsoft.com`
   - Custom API: `api://<downstream-client-id>`
5. Save the server. When assigning tools to an agent or gateway, set the resolution type to **Resolve at call time**.

Servers running in cluster pods must use **streamable-http** transport to support per-request token exchange.
