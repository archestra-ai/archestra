---
title: Quickstart
category: Archestra Platform
order: 1
description: Get started with Archestra Platform using Docker
lastUpdated: 2025-10-08
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

-->

👋 Welcome! 

Archestra.AI is an open source "AI Platform" for your organization, whether it's a small startup or a large enterprise, helping you build and deploy practical agents that safely operate on internal and external data.

![Agent Platform Swarm](/docs/platform-agents-swarm.png)

Archestra is an open source platform built from multiple components:
- ChatGPT-like UI
- Agent Builder
- Powerful MCP orchestrator
- Unique deterministic security layer (this is important!) preventing agents from going rogue

...and a few others built for those considering Archestra for real-world production, like OTEL exporter, cost tracker, and optimizer.

> Fun fact: The team behind Archestra.AI previously worked on Grafana OnCall.

## Run it locally to try!

We've prepared a all-in-one Docker image for you. Once it's up, follow http://localhost:3000

**Linux / macOS:**

```bash
docker pull archestra/platform:latest;
docker run -p 9000:9000 -p 3000:3000 \
   -e ARCHESTRA_QUICKSTART=true \
   -v /var/run/docker.sock:/var/run/docker.sock \
   -v archestra-postgres-data:/var/lib/postgresql/data \
   -v archestra-app-data:/app/data \
   archestra/platform;
```

**Windows (PowerShell):**

```powershell
docker pull archestra/platform:latest;
docker run -p 9000:9000 -p 3000:3000 `
   -e ARCHESTRA_QUICKSTART=true `
   -v /var/run/docker.sock:/var/run/docker.sock `
   -v archestra-postgres-data:/var/lib/postgresql/data `
   -v archestra-app-data:/app/data `
   archestra/platform;
```

## Build Your First Agent `Easy`

1. Go to **MCP Registry**, add new and search for `microsoft__playwright-mcp`, install it.
2. Gaze at Archestra running the MCP server in Kubernetes cluster! (If you want to make sure: `kubectl get pods`)
3. Go to **Agents** and create "Archestra Docs Reader Agent" with this system prompt: `You're using playwright to answer questions about Archestra based on https://archestra.ai/docs/`
4. While editing the agent, make sure to enable all `microsoft__playwright-mcp` tools for it.
5. Go to **Settings -> LLM API Keys** and add your preferred provider. You can connect commercial providers like OpenAI, Anthropic, or Google Gemini. For a free option, use [Cerebras](https://cerebras.ai/) or a local [Ollama](https://ollama.com/) instance.
6. Go to **Chat**, choose the "Archestra Docs Reader Agent" and ask "How could I deploy Archestra?"
![Archestra Chat UI calling the agent](/docs/quickstart-agent-chat.png)
7. Enjoy Archestra navigating the website for you!

## Connect to Your Agent via MCP Gateway `Advanced`

Archestra is not just a Chat UI, it's a very capable MCP Gateway. Let's connect our "Archestra Docs Reader Agent" to **Claude Code** to make sure we could trigger it as an MCP server!

```mermaid
graph LR
    A[Claude] --> B[Archestra]
    subgraph B[Archestra]
        B1[MCP Gateway] --> B2[MCP Orchestrator in K8S]
        subgraph B2[MCP Orchestrator in K8S]
            B3[Playwright Headless Browser]
        end
    end
```

1. Go to **MCP Gateways**, create a new one.
2. Make sure to set "Archestra Docs Reader Agent" as a sub-agent.
3. Save changes and Copy MCP configuration.
4. Add MCP Gateway to your Claude. Here is my archestra config (your auth key will be different!):
```
{
  "mcpServers": {
    "archestra": {
      "url": "http://localhost:9000/v1/mcp/e1b0272c-3839-4575-a49d-aabb864d638d",
      "headers": {
        "Authorization": "Bearer archestra_119220a7bfc485d66b678d3e9fb2db36"
      }
    }
  }
}
```
I converted it to the command for claude:
```
claude mcp add archestra "http://localhost:9000/v1/mcp/e1b0272c-3839-4575-a49d-aabb864d638d" --transport http --header "Authorization: Bearer archestra_119220a7bfc485d66b678d3e9fb2db36"
```

, and now ask Claude:
```
Ask archestra to give you all the deployment options.
```

Feel the magic ✨

## What's next?

- [Chat Interface](/docs/platform-chat) - Interact with AI agents using MCP tools
- [Agents](/docs/platform-agents) - Build autonomous agents with no-code
- [LLM Proxy](/docs/platform-llm-proxy) - Secure your AI applications
- [MCP Gateway](/docs/platform-mcp-gateway) - Connect external systems to agents
- [Deployment](/docs/platform-deployment) - Deploy Archestra in production
- [Brew By Weight? Brew By AI!](https://archestra.ai/blog/brew-by-ai) - Fun post about building MCP, running it in Archestra to get the perfect espresso.
- [Join our Slack Community](https://join.slack.com/t/archestra-community/shared_invite/zt-2v2gsjn4p-OqIYN7xR8PqnFLvpQBqBXw) - Connect with other users and the team