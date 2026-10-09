---
title: Microsoft Foundry
description: Connect a Foundry agent to Archestra MCP Gateway tools
order: 8
lastUpdated: 2026-10-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A Microsoft Foundry agent can use Archestra's MCP Gateway as a remote tool server. Foundry continues to host the model; this setup routes tool calls through Archestra, not model inference.

## Requirements

You need a Foundry project and permission to configure agents and project connections. Your Archestra MCP Gateway must be reachable from Foundry over HTTPS. A local `localhost` address is not reachable from the hosted service.

In Archestra, create an [MCP Gateway](/docs/mcp/gateway), assign the tools the agent needs, and copy its connection URL. Use a gateway token whose access fits the Foundry project's users. Credentials stored in a Foundry project connection are shared within that project.

## Connect the Gateway

1. Open your agent in the Foundry portal and add a remote **MCP** tool.
2. Give it a label, such as `archestra`, and enter `https://api.example.com/v1/mcp/<gateway-id>` as the server URL. Use the URL copied from Archestra.
3. Select key-based authentication. Set the credential name to `Authorization` and its value to `Bearer <gateway-token>`.
4. Save the project connection and attach it to the agent's MCP tool. Select the tools the agent needs and keep tool-call approval enabled for the first test.

Foundry stores the credential in its project connection and includes it in gateway requests. See Microsoft's [MCP authentication setup](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication) and [remote MCP connection guide](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol) for the controls in your agent type.

## Verify the Connection

Ask the agent to perform a read-only action supported by an assigned tool. Review the requested tool and arguments in Foundry before approving it. Confirm that the response includes the tool's result, then open **Logs → MCP Gateway** in Archestra and find that call.

If Foundry cannot discover tools, check the gateway URL, network reachability, bearer token, and tool assignments. With progressive tool loading enabled, the initial list contains discovery tools rather than every assigned tool; see [Progressive Tool Loading](/docs/mcp/gateway#load-tools-when-needed).

Use [guardrails](/docs/agents/guardrails) to control which gateway tool calls an agent can make. Foundry's approval settings are separate from guardrails.
