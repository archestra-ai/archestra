---
title: "Slack A2A Integration"
category: "Examples"
order: 8
description: "Connect Slack to Archestra prompts via A2A protocol"
lastUpdated: "2025-12-30"
---

# Slack A2A Integration

Forward Slack slash commands to an Archestra prompt using the A2A protocol.

## Prerequisites

- Slack workspace with permission to install apps
- Archestra prompt with A2A token (see [Prompts](/docs/platform-prompts))
- Node.js 18+

## Create Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **From manifest**. Paste this YAML:

```yaml
display_information:
  name: Archestra Bot
features:
  bot_user:
    display_name: Archestra
    always_online: true
  slash_commands:
    - command: /ask
      description: Ask Archestra
      usage_hint: "[question]"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
```

After creating:

1. Go to **OAuth & Permissions** > **Install to Workspace**
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
3. Go to **Basic Information** > **App-Level Tokens** > **Generate Token** with `connections:write` scope
4. Copy the **App-Level Token** (starts with `xapp-`)

## Bot Code

```bash
pnpm init
pnpm add @slack/bolt tsx
```

Create `index.ts`:

```typescript
import { App } from "@slack/bolt";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.command("/ask", async ({ command, ack, respond }) => {
  await ack();

  const res = await fetch(
    process.env.ARCHESTRA_PROMPT_A2A_ENDPOINT!,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.ARCHESTRA_PROMPT_A2A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: command.text }] } },
      }),
    }
  );

  const data = await res.json();
  await respond(data.result?.parts?.[0]?.text ?? "No response");
});

app.start().then(() => console.log("Running"));
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-Level Token (`xapp-...`) |
| `ARCHESTRA_PROMPT_A2A_ENDPOINT` | Full A2A endpoint URL (e.g. `http://localhost:9000/v1/a2a/{promptId}`) |
| `ARCHESTRA_PROMPT_A2A_TOKEN` | A2A token (e.g. `archestra_24b0...`) |

## Run

```bash
pnpm tsx index.ts
```

In Slack, type `/ask what is the weather?` to test.
