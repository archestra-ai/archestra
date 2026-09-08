---
title: External A2A Agents
category: Agents
order: 13
description: Connect external Agent2Agent systems and use them as subagents
lastUpdated: 2026-09-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

External A2A agents let an Archestra agent delegate work to another Agent2Agent system. The remote system stays under its owner's control. Archestra manages the connection, assignment, guardrails, and call history.

External targets appear with local subagents in an agent's configuration. An **External A2A** badge identifies calls that leave Archestra.

## Connect An External Agent

Go to **Studio → Agents → External A2A**, then select **Connect agent**.

Archestra supports three Agent Card sources:

- **Well-known URL** discovers the card from an agent's base URL.
- **Direct Agent Card URL** reads a card from the exact URL you provide.
- **Paste Agent Card JSON** stores a card supplied by the remote agent's owner.

Use **Test connection** before saving. The test validates the card, authentication choice, and supported protocol interface.

Archestra supports A2A 1.x endpoints over JSON-RPC and HTTP+JSON. The selected endpoint is pinned from the validated card.

## Authentication

A connection can use no authentication, a bearer token, or an API key header. Archestra stores credentials separately from the public Agent Card.

The chosen method must satisfy one security requirement advertised by the card. A bearer-protected card needs a bearer token, for example.

OAuth discovery and interactive sign-in are not part of this first release. Use a static bearer token or API key when the remote system requires authentication.

## Assign An External Subagent

Open the parent agent and go to **Tools & Knowledge → Subagents**. Select **Add external**, choose the connection, then save the agent.

External targets are always assigned explicitly. **Auto** mode can discover local subagents, but it never adds an external connection automatically.

The parent agent sees each assignment as a delegation tool. It decides what text to send in the tool's `message` field. Archestra does not forward the parent prompt, conversation history, or inbound credentials.

## Guardrails And Monitoring

Each external target has the same tool invocation and result policies as other callable tools. Invocation policies run before any network request. Result policies classify data returned by the remote system before the parent uses it.

Archestra records each attempt with its parent agent, caller, conversation, state, and timing. Remote task and context identifiers are retained when the endpoint returns them. The run record keeps target and interface snapshots after a connection is removed.

Remote output remains opaque to Archestra beyond the A2A response. The remote system controls its own processing, retention, and downstream access.

## Example

A support team owns a private investigation agent. They connect its Agent Card instead of exposing its MCP servers to Archestra. The team's triage agent can delegate a case summary and receive the result through the normal subagent flow. Archestra applies tool guardrails and records the outcome. The support team keeps control of its internal tools and data.
