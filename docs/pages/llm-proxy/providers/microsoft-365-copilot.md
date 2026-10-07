---
title: Microsoft 365 Copilot
description: Connect Microsoft 365 Copilot to answer questions using the signed-in user’s work data.
order: 8
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Ask [Microsoft 365 Copilot](https://www.microsoft.com/en-us/microsoft-365/copilot) from Archestra, and get answers from your mail, SharePoint, Teams, and the web. Archestra connects to it through the [Microsoft 365 Copilot Chat API](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview) (Microsoft Graph, beta). Like GitHub Copilot, there are no static API keys: access is tied to an individual Microsoft work account with a Microsoft 365 Copilot license.

## Proxy Endpoint

- **Base URL**: `https://<archestra-host>/v1/microsoft-365-copilot`
- **Authentication**: Pass the stored **Entra refresh token** (the credential below) in the `Authorization` header as `Bearer <token>`

## Entra App Registration

The sign-in flow needs an [Entra ID app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) owned by your organization:

1. Register an application in the Microsoft Entra admin center. The device flow runs as a public client — skip the client secret and redirect URI.
2. Enable **Allow public client flows** (Authentication → Advanced settings). Without it, sign-in fails after the code is entered.
3. Add these **delegated** Microsoft Graph permissions and grant admin consent: `Sites.Read.All`, `Mail.Read`, `People.Read.All`, `OnlineMeetingTranscript.Read.All`, `Chat.Read`, `ChannelMessage.Read.All`, `ExternalItem.Read.All`. The Chat API requires all seven — one per data source Copilot searches.
4. Set [`ARCHESTRA_MICROSOFT_365_COPILOT_CLIENT_ID`](/docs/reference/configuration#ARCHESTRA_MICROSOFT_365_COPILOT_CLIENT_ID) to the Application (client) ID.
5. For a **single-tenant** registration, also set [`ARCHESTRA_MICROSOFT_365_COPILOT_TENANT_ID`](/docs/reference/configuration#ARCHESTRA_MICROSOFT_365_COPILOT_TENANT_ID) to your tenant ID. The default (`organizations`) only works for multi-tenant registrations.

With a multi-tenant registration, users from another organization can sign in once their own tenant admin consents to the app.

## Connecting Your Account

A Microsoft 365 Copilot provider key stores a **long-lived Entra refresh token** for an account with a Microsoft 365 Copilot license. Archestra redeems it for a short-lived Graph access token on every request (cached and refreshed automatically). Entra rotates refresh tokens; Archestra persists the rotated token back to the key.

To connect, use the **Sign in with Microsoft** button when adding a Microsoft 365 Copilot key. It runs Entra's OAuth device flow — you approve a one-time code on Microsoft's device sign-in page, and Archestra stores the resulting refresh token.


## Limits

Each user needs a Microsoft 365 Copilot license and a work or school account. Credentials are personal and cannot be shared. This model returns text only and cannot call tools; proxy requests that declare tools are rejected. Usage counts are estimates because the API returns no token counts. Keep requests to questions and answers: long-running work can time out.
