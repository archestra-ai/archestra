---
title: External Agents
category: Agents
order: 13
description: Connect external Agent2Agent systems and use them as subagents
lastUpdated: 2026-09-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

External A2A agents let an Archestra agent delegate work to another Agent2Agent system. The remote system stays under its owner's control. Archestra manages the connection, assignment, guardrails, and call history.

External targets appear in the same **Subagents** configuration panel as local subagents, in a compact **External Agents** group that identifies calls leaving Archestra.

## Connect An External Agent

Go to **Studio → Agents → External Agents**, then select **Connect agent**. Connection setup opens on its own page, matching the create flow for internal agents.

Only users with the **Agent settings: update** permission—organization administrators by default—can create, change, or remove these credential-bearing connections. Members who can edit an agent can assign connections that a settings manager has approved and that are visible to them.

Enter the remote agent's base URL. Archestra discovers its Agent Card from `/.well-known/agent-card.json` and shows the detected agent beside the field.

Discovery checks media modes, required extensions, and the supported protocol interface. Saving checks the selected authentication scheme against the card. It does not send a task or validate the credential. The connection is marked verified only after a successful delegation.

Archestra supports A2A 1.x endpoints over JSON-RPC and HTTP+JSON. The selected endpoint is pinned from the validated card.

## Visibility

Choose who can discover and assign an external A2A agent when you connect or edit it:

- **Personal** makes it available only to its creator.
- **Users** makes it available to its creator and the specifically selected people.
- **Team** makes it available to members of the selected teams.
- **Organization** makes it available to everyone in the organization.

Existing external A2A agents are organization-visible after upgrading, preserving their previous availability. Users with **Agent settings: update** can still manage every external connection because the settings include stored credentials; visibility controls who sees it as assignable and who can assign or invoke it.

Use the visibility filters on the External Agents page to narrow the card or table view by scope, owner, or team.

## Edit Or Remove An External Agent

Select an external agent card or table row to open its detail page. Settings managers can change its base URL, authentication, display details, or visibility, then select **Save changes**. To pause or resume the connection everywhere without removing its assignments, use **Disable delegation** or **Enable delegation** in the page actions menu. Leave the credential blank to keep the stored secret.

The **Edit** action opens the same detail page. To remove a connection, first remove its assignments from internal agents, then open the ellipsis menu and select **Delete**. Removing it also removes its stored credential.

## Authentication

A connection can use no authentication, a bearer token, or an API key header. The connection record stores a secret reference, not the credential value, and public A2A responses expose only whether a credential is configured. This is the same shared secrets system used for LLM provider keys, MCP server credentials, knowledge connectors, and agent runtime credentials; depending on the deployment, it uses encrypted database storage or the configured Vault integration.

The chosen method must satisfy one security requirement advertised by the card. A bearer-protected card needs a bearer token, for example.

OAuth discovery and interactive sign-in are not part of this first release. Use a static bearer token or API key when the remote system requires authentication.

## Assign An External Subagent

Open the parent agent and go to **Tools & Knowledge → Subagents**. In the **External Agents** group, select **Add external**, choose the connection, then save the agent.

External targets are always assigned explicitly. **Auto** mode can discover local subagents, but it never adds an external connection automatically.

Outbound A2A is currently available only to agents in the Default environment. Environment-bound agents do not advertise or invoke external targets until A2A traffic can use that environment's network policy.

The parent agent sees each assignment as a delegation tool. It decides what text to send in the tool's `message` field. Archestra does not forward the parent prompt, conversation history, or inbound credentials.

## Guardrails And Monitoring

Each external target has the same tool invocation and result policies as other callable tools. Invocation policies run before any network request. Result policies classify data returned by the remote system before the parent uses it.

Archestra records each attempt with its parent agent, caller, conversation, state, and timing. Remote task and context identifiers are retained when the endpoint returns them. Each connection card shows its latest activity to administrators. The run record keeps target and interface snapshots after a connection is removed.

For asynchronous A2A responses, Archestra stores the task identity, polls through the official SDK until the task reaches a terminal state, and asks the remote agent to cancel if the parent request is aborted or the five-minute execution deadline is reached.

Remote output remains opaque to Archestra beyond the A2A response. The remote system controls its own processing, retention, and downstream access.

## Example

A support team owns a private investigation agent. They connect its base URL instead of exposing its MCP servers to Archestra. The team's triage agent can delegate a case summary and receive the result through the normal subagent flow. Archestra applies tool guardrails and records the outcome. The support team keeps control of its internal tools and data.
