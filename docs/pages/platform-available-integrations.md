---
title: Available Integrations
category: Archestra Platform
order: 9
description: Turn off the model providers, messaging channels, and knowledge connectors your organization does not allow, and rename the ones it does
lastUpdated: 2026-08-17
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

![The Model Providers page with the admin-only Page settings dialog open](/docs/automated_screenshots/platform-available-integrations_provider-settings.webp)

Archestra ships with a long catalog of model providers, messaging channels, and knowledge connectors. Most organizations only allow a few of them. As an admin you can turn the rest off, so nobody has to guess which ones are approved.

Each catalog has its own **Page settings** dialog, on the page where the catalog lives:

- Model providers — the Page settings button on Model Providers.
- Messaging channels — the Page settings button on Messaging Channels.
- Knowledge connectors — the Page settings button on Connectors.

Only admins see the button. It works the same way as the Connect page settings.

## Turning an Integration Off

Switch **Available** off for anything your organization does not allow. A turned-off integration disappears from every picker, and the API refuses to configure it — so it stays off even for someone using the API directly or an old browser tab.

Turning a messaging channel off also stops it listening. A Slack bot that was already connected stops answering, and email stops reaching agents.

Credentials and connectors that already exist keep working, so turning a provider off never breaks live traffic mid-flight. They are marked as turned off in the list, and you can delete them when you are ready — a retired provider's key can no longer be edited or rotated.

## Renaming an Integration

Each row also takes a display name and a short description. The display name replaces the built-in one everywhere the integration appears — pickers, tables, and tabs. Leave it empty to keep the name the integration ships with.

Use the description to say what the integration is for in your organization, for example which team owns the account. It shows up next to the integration in the connector chooser.

## Use Case

Northwind Robotics allows OpenAI and Gemini for model traffic, and nothing else. Their admin opens Page settings on Model Providers, presses **Turn all off**, then switches the two approved providers back on. She renames OpenAI to "OpenAI (Finance-approved)" so engineers know which one to pick.

An engineer opening Add API Key now sees exactly two providers. When one of them pastes an old Anthropic key into the API, the request is refused.
