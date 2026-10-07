---
title: External Agents
description: Connect external Agent2Agent systems and use them as subagents
order: 2
lastUpdated: 2026-09-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Delegate to agents that run outside Archestra. Connect any agent that speaks [A2A](https://a2a-protocol.org/), and your agents can hand it work like any other subagent. Its owner keeps control of its tools and data. Archestra checks and records every call.

For example, a support team keeps its investigation agent private, and connects only its URL. A triage agent in Archestra then delegates case summaries to it.

<span id="connect-an-external-agent"></span><span id="ownership"></span>

## Connect an External Agent

You need [`agent:read`](/docs/reference/permissions#agent:read) and [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

1. Go to **Agents**, click **Add Agent**, then **Add an External Agent**.
2. Enter the agent's base URL and its authentication: none, a bearer token, or an API key.
3. Under **Permissions**, click **Add access** to share it with people, teams, or everyone in the organization. Left alone, only you can use it.
4. Click **Connect agent**. Archestra reads and checks its Agent Card first.

The connection shows as verified after its first successful call.

What to know:

- **Supported:** A2A 1.x over JSON-RPC or HTTP+JSON. OAuth sign-in is not supported. Use a static token or key.
- Credentials are stored as secrets, never in plain text.
- To pause a connection, click **Disable delegation**. Its assignments stay.
- To change who can use it later, open the external agent and edit its **Permissions** section. **Can use** lets someone assign it as a subagent. **Can edit** also lets them change its connection.

<span id="visibility"></span><span id="edit-or-remove-an-external-agent"></span><span id="authentication"></span><span id="assign-an-external-subagent"></span>

## Assign It to an Agent

1. Open the parent agent and go to **Tools, Skills & Knowledge → Subagents**.
2. Under **External Agents**, click **Add external** and choose the connection.
3. Save the agent.

What to know:

- Only agents in the Default environment can call external agents for now.
- Archestra sends only the message the parent agent writes. It never forwards the chat history, the system prompt, or your credentials.

<span id="guardrails-and-monitoring"></span><span id="example"></span>

## Guardrails and Monitoring

- **Checked like a tool call:** [Guardrails](/docs/agents/guardrails) check each call before it leaves, and check the result before the parent agent uses it.
- **Recorded:** each call keeps its parent agent, caller, chat, state, and timing.
- **Time limit:** a long-running remote task is canceled after five minutes, or when the parent agent stops.
- Beyond the response, the remote system controls what it does with your data.
