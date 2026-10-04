---
title: Quickstart
category: Archestra Platform
order: 1
description: Run Archestra locally and ask your first agent a question.
lastUpdated: 2026-10-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

This tutorial uses the all-in-one Docker image for a local evaluation. For a production installation, use the [Deployment guide](/docs/platform-deployment).

## Before You Start

You need Docker running on your machine and credentials for a supported [model provider](/docs/platform-supported-llm-providers). The example agent also needs internet access to read the documentation.

<span id="run-it-locally-to-try"></span>

## Run Archestra

**Linux / macOS:**

```bash
docker pull archestra/platform:latest
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000 \
   -e ARCHESTRA_QUICKSTART=true \
   -v /var/run/docker.sock:/var/run/docker.sock \
   -v archestra-postgres-data:/var/lib/postgresql/data \
   -v archestra-app-data:/app/data \
   archestra/platform:latest
```

**Windows (PowerShell):**

```powershell
docker pull archestra/platform:latest
docker run -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000 `
   -e ARCHESTRA_QUICKSTART=true `
   -v /var/run/docker.sock:/var/run/docker.sock `
   -v archestra-postgres-data:/var/lib/postgresql/data `
   -v archestra-app-data:/app/data `
   archestra/platform:latest
```

Open [http://localhost:3000](http://localhost:3000) when the container is ready. The API listens at [http://localhost:9000](http://localhost:9000). Both ports bind to your local machine.

The named volumes preserve your database and application data between container runs.

## Connect a Model Provider

Switch to **Studio** and open **Model Providers**. Add your provider credentials before using Chat. See [Supported LLM Providers](/docs/platform-supported-llm-providers) for provider-specific setup.

<span id="build-your-first-agent-easy"></span>

## Create a Docs Reader Agent

This example uses a browser tool to answer questions about Archestra documentation.

1. In **MCP Registry**, search for `microsoft__playwright-mcp` and install it.
2. In **Agents**, create an agent named **Archestra Docs Reader**.
3. Set its instructions to: `Use Playwright to read https://archestra.ai/docs/ and answer questions about Archestra. Cite the documentation pages you use.`
4. Enable the installed Playwright tools for the agent and save it.
5. Switch to **AI**, open **Chat**, and select the agent and a model.
6. Ask: `How can I deploy Archestra?`

The agent uses its browser tools to read the docs, then returns an answer. You can inspect the tool calls in the chat.

![Archestra Chat UI calling the agent](/docs/quickstart-agent-chat.webp)

<span id="connect-to-your-agent-via-mcp-gateway-advanced"></span>
<span id="whats-next"></span>

## Next Steps

- [Chat](/docs/platform-chat): Continue working with your agent.
- [Agents](/docs/platform-agents): Configure tools, sub-agents, and triggers.
- [MCP Gateway](/docs/platform-mcp-gateway): Connect external clients to selected tools.
- [Connect to Archestra](/docs/platform-connection): Configure applications and MCP clients.
- [Deployment](/docs/platform-deployment): Run Archestra for your team.
