---
title: "Okta"
description: "Configure Okta for SSO sign-in and RFC 8693 token exchange for MCP tools"
order: 3
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect Okta to sign users in with Okta credentials and exchange tokens so MCP tools call downstream APIs under each user's identity.

For sign-in alone, complete sections 1–3. For per-user tool access, complete sections 4–6.

## 1. Register the Okta Application

Use the published Okta Integration Network (OIN) app or create a custom OIDC integration.

### Option A: Install from Okta Integration Network (Recommended)

1. In the Okta Admin Console, go to **Applications → Applications → Browse App Catalog**.
2. Search for **Archestra** and click **Add integration**.
3. Under **General Settings**, enter your bare Archestra domain without protocol (e.g. `archestra.example.com`).
4. Assign the users or groups allowed to access Archestra.
5. On the **Sign On** tab, copy the **Client ID** and **Client Secret**.
6. Disable DPoP: in **General → Client Credentials**, ensure **Require Demonstrating Proof of Possession (DPoP)** is disabled.

### Option B: Create a Custom OIDC Integration

1. Go to **Applications → Applications → Create App Integration**.
2. Select **OIDC - OpenID Connect** and **Web Application**.
3. Set **Sign-in redirect URIs** to:
   `https://<archestra-domain>/api/auth/sso/callback/Okta`
4. Set **Sign-out redirect URIs** to:
   `https://<archestra-domain>/auth/sign-in`
5. Under **Assignments**, assign allowed users or groups, save, and copy the **Client ID** and **Client Secret**.

## 2. Configure SSO in Archestra

1. In Archestra, go to **Settings → Identity Providers** and click **Enable** on **Okta**.
2. Set **Issuer** to your Okta organization URL (e.g. `https://example.okta.com`).
3. Paste the **Client ID** and **Client Secret**.
4. Leave **Discovery Endpoint** empty (Archestra discovers OIDC metadata automatically).
5. Click **Create Provider**.

Test sign-in in an incognito browser window.

## 3. Map Roles and Sync Teams

Configure claim mapping to assign roles and teams on sign-in:

- **Role Mapping:** In Okta, include the `groups` claim in ID tokens. In Archestra, create rules matching groups like `Archestra_Admins` to target roles. See [Role Mapping](/docs/admin/identity/sso#role-mapping).
- **Team Sync:** Link Archestra teams to Okta group names in **Settings → Teams**. See [Team Sync](/docs/admin/identity/sso#team-sync).

## 4. Configure Okta for Token Exchange

To call downstream APIs as the calling user, configure Okta to accept signed token-exchange requests:

1. Generate a PKCS#8 RSA keypair.
2. In the Okta Admin Console, open your Archestra application's **General** settings.
3. Under **Client Authentication**, select **Public Key / Private Key** and add your public key. Save the assigned **Key ID (kid)**.
4. Enable the token-exchange grant type: `urn:ietf:params:oauth:grant-type:token-exchange`.
5. In your authorization server policies, allow the Archestra app to request tokens for downstream API audiences.

## 5. Enable Token Exchange in Archestra

1. In **Settings → Identity Providers**, edit **Okta** and expand **Enterprise-Managed Credentials**.
2. Set **Exchange Token Endpoint** to `https://<org>.okta.com/oauth2/v1/token`.
3. Set **Exchange Client Authentication** to **Private key JWT**.
4. Enter your **Signing Key ID** and paste your **Private Key PEM**.
5. Set **User Token To Exchange** to **ID token**.
6. Save the provider.

## 6. Configure MCP Server Multitenant Auth

1. In **MCP Servers**, open target catalog item and select **Multitenant Authorization**.
2. Choose **Identity Provider Token Exchange** and select **Okta**.
3. Set **Requested Credential** to **Bearer token** and **Injection Mode** to **Authorization: Bearer**.
4. Set **Managed Resource Identifier** to the target downstream audience or scope (e.g. `api://internal-service`).
5. When assigning tools from this server to an agent or gateway, choose **Resolve at call time**.

Servers running in cluster pods must use **streamable-http** transport to support per-request token exchange.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Okta tile opens 404 or loop | Protocol prefix in OIN settings | In Okta OIN settings, verify the hostname contains no `https://` or trailing path. |
| `invalid_dpop_proof` | DPoP enforcement enabled | In Okta app settings under **Client Credentials**, disable DPoP. |
| User denied after Okta login | Strict mode with no matching role | Verify user matches a rule in **Role Mapping** or disable Strict Mode. |
| Sign-out displays error | Missing logout redirect URI | Add `https://<domain>/auth/sign-in` to Okta's allowed **Sign-out redirect URIs**. |
