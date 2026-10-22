---
title: Identity Providers
description: Connect workplace sign-in and per-user tool access
order: 4
lastUpdated: 2026-10-22
---

<span id="adding-a-provider"></span><span id="supported-providers"></span>


Connect your identity provider for either or both:

- **Workplace sign-in:** let people sign in with their company accounts. [Single Sign-On](/docs/admin/identity/sso) maps directory claims to Archestra roles and teams.
- **Tools acting as each person:** exchange the caller's company token for a downstream API token. Follow the provider-specific setup for [Microsoft Entra ID](/docs/admin/identity/entra-obo) or [Okta](/docs/admin/identity/okta).

Identity providers are an [Enterprise feature](/docs/get-started/pricing-model). Setup requires admin access in your provider and [`identityProvider:create`](/docs/reference/permissions#identityProvider:create) in Archestra.

![The Identity Providers settings page](/docs/automated_screenshots/platform-identity-providers_sso-providers-overview.webp)
