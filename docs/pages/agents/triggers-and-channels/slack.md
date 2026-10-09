---
title: Slack
description: Give each Archestra agent its own Slack bot
order: 3
lastUpdated: 2026-10-10
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Each agent gets its own Slack bot, and people @mention it by name: `@archestra_marketing` and `@archestra_coding` can work in the same channel, even the same thread. The answer streams in as the agent writes it, and a **Stop** button ends it.

<span id="prerequisites"></span><span id="setup"></span><span id="agent-bots"></span>

## Connect Slack

You paste one token pair from Slack once, and Archestra creates a Slack app for every agent you add. You need a Slack workspace where you can install apps.

1. Go to **Settings → Messaging Channels → Slack** and click **Connect Slack**.
2. On [api.slack.com/apps](https://api.slack.com/apps), click **Generate Token** under **Your App Configuration Tokens**, and paste both tokens. Archestra renews them itself.
3. Click **Add Slack bot**, pick the agent, and keep or change its Slack name.
4. Approve the install in Slack. In Socket Mode, also paste the app-level token Slack shows; Slack has no API to create it.
5. Invite the bot to the channels where people should reach it: `/invite @archestra_marketing`.

What to know:

- **Name and icon:** the bot uses the agent's icon and keeps it in sync. Renaming the agent renames the bot, unless you picked its Slack name yourself. Slack app icons must be images, so an emoji icon keeps Slack's default.
- **Reinstall:** when Slack needs new permissions, the bot's row says so and links to its Slack page.
- **An app connected before:** it is listed for conversion. Pick the agent it should answer as; it keeps its name, channels, and DMs.

Connection mode and the token live under **Advanced**:

| | Socket Mode (Default) | Webhook Mode |
| --- | --- | --- |
| **Connects** | Archestra connects to Slack | Slack calls your public URL |
| **Needs a public URL** | No | Yes |
| **Use it for** | Local setups, firewalls, VPNs | Production with a stable URL |

With an HTTPS address, installing a new bot is one click: Slack sends you back to Archestra with the bot connected.

<span id="usage"></span><span id="first-message"></span><span id="default-agent"></span><span id="replying-within-a-thread"></span><span id="answering-every-message"></span>

## When a Bot Answers

- In a channel, a bot answers when you mention it.
- In a thread, one mention is enough. It then answers every message in that thread.
- In a direct message, it answers every message.
- Mentioning one bot does not wake another in the same thread.

To quiet a thread, press **Stop** while the bot is working. It drops the answer in progress and stops answering that thread. Mention it again to wake it.

<span id="streaming"></span>

## Watch the Answer Arrive

The answer appears as the agent writes it, so a long one never leaves the thread silent. Each tool call shows as a step that turns done or failed.

- **Streaming:** in direct messages and threads where you mentioned the bot. Elsewhere the full answer posts at once, because the agent may decide to stay quiet.
- **Suggested prompts:** the agent's first four suggested prompts wait at the top of the bot's direct messages.

<span id="channel-instructions"></span>

## Channel Instructions

Tell the agent how to behave in one channel. Open the channel's **Settings** and write them as you would talk to the agent. For example: "Every message here is a task. Create it at once, and do not ask first."

They come first, before the agent's own instructions. They add to what the agent does, and never remove an ability.

<span id="autoprovisioning-slack-users"></span><span id="attachments"></span><span id="commands"></span><span id="switching-agents-inline"></span>

## What to Know

- **New people:** someone who messages a bot without an Archestra account gets one. It has the organization's default role for new users, set in **Settings → Auth**. Find these accounts in **Settings → Users**.
- **Welcome message:** the bot DMs a new person a sign-up link, or a sign-in link when you use [SSO](/docs/admin/identity/sso). To turn it off, set [`ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED).
- **Files:** the agent reads images, PDFs, and text files such as CSV, JSON, and Markdown. Files posted earlier in the same thread count too. With a [code sandbox](/docs/agents#code-sandbox), it can open other files, such as ZIP archives.
- **File limits:** 20 files per message, 10 MB per file, 25 MB in total. Archestra skips larger files and tells the agent which files it did not get.
- **Agent experience:** connecting moves your existing Slack apps to Slack's agent experience, which the **Stop** button and DM prompts need. Slack cannot switch an app back.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **The bot does not answer** | Invite it to the channel. In webhook mode, make sure Slack can reach your URL. In socket mode, look for "Socket mode connected" in the backend logs. |
| **"Needs reinstall"** | Open the app's Slack page from the bot's row, click **Reinstall to Workspace**, then **Check again**. |
| **Slack shows a server error after approving the install** | The install often went through anyway. Open the app's **OAuth & Permissions** page; if a bot token is there, paste it in **Finish setup**. |
| **"Request verification failed"** | Webhook mode only. Check the signing secret on the app's **Basic Information** page, and your server's clock. |
| **Socket mode disconnects** | Check that the app-level token has the `connections:write` scope, and that Archestra can reach the internet. It connects again on its own. |
| **"Could not verify your identity"** | The app needs the `users:read` and `users:read.email` scopes. Reinstall it from its Slack page. |
