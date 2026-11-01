---
title: Guardrail Clients
sidebarTitle: Clients
description: Make Guardrails check your client, with built-in support or session headers
order: 3
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-11-01
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check the tool calls of any client that sends its traffic through the Archestra [LLM Proxy](/docs/llm-proxy). Built-in clients work out of the box. Any other client needs to add the `X-Appa-Session-ID` and `X-Appa-Parent-ID` headers.

<a id="supported-clients"></a><a id="connect-a-client"></a>

## Connect a Supported Client

These clients work without extra configuration:

- **Archestra Chat**
- **Claude Code**
- **Claude Desktop** (Code and Cowork tabs)
- **Codex CLI**
- **Copilot CLI** (see [Copilot CLI](#copilot-cli) for the providers it works with)
- **Pi**
- **OpenCode**
- **Kilo Code**
- **Kimi Code**

Connect the client to the LLM Proxy and the MCP Gateway on the [connection page](/docs/get-started/connect). The client needs both: the LLM Proxy checks each tool call, and the MCP Gateway gives the agent the tools to handle a block, such as [`get_remedy_plans`](/docs/reference/archestra-mcp-server#get_remedy_plans) and [`yell`](/docs/reference/archestra-mcp-server#yell).

### Use Guardrails in Kimi Code

Kimi Code shows a review in its own question form: choose **Inspect**, **Allow**, or **Deny**. **Inspect** shows the complete review, and you then choose **Allow** or **Deny**. Escape closes the form without approving or denying.

- Subagents run under Guardrails only as new foreground `Agent` calls. A background, resumed, or swarm subagent is refused before it starts.
- Setup starts Kimi Code in Ask When Needed mode, so the guardrail helpers run without a prompt. Kimi Code 2.3.3 cannot approve single gateway tools, so this mode also runs your other gateway calls and routine commands without asking. It still asks before dangerous commands and shows reviews.

### Review Calls in OpenCode and Kilo Code

The connection plugin shows a command preview and the scope of an approval before you choose **Allow** or **Deny**. Choose **Inspect** for the exact arguments and full policy review. **Dismiss** or Escape closes the question without approving or denying.

Reconnect through the connection page and restart the client to install the question dialog. This requires a managed connection over HTTPS.

| Surface | Question Display |
| --- | --- |
| OpenCode CLI 1.19.3 and compatible later 1.x releases | Compact dialog with pages for long previews and full reviews. |
| Kilo Code CLI 7.8.15 and compatible later 7.x releases | The same dialog using Kilo's native controls. |
| Older versions, OpenCode 2, or an unavailable TUI extension | The client's native question UI. |
| Editor webviews, including Kilo's VS Code chat | Native question UI. Running a supported CLI in an editor terminal uses the CLI dialog. |

- **Inspect** requires a separate answer afterward. Reading or paging through the review never selects **Allow**.
- Multi-question and multi-select forms, small terminals, and forms with many or long option labels use the native UI.
- An existing `tui.jsonc` is preserved without automatic registration. The native question remains available.

<a id="copilot-cli"></a>

### Copilot CLI

Guardrails follow a Copilot CLI session when its model requests use the OpenAI Responses API. Copilot names its conversation only there. Setup selects that API when the proxy serves it for your provider: OpenAI, Azure, GitHub Copilot, or xAI. On other providers Copilot keeps the Chat Completions API, and the proxy treats it as an unrecognized client.

- **Reconnect to turn it on:** a Copilot CLI connected before this support stays on the Chat Completions API. Connect it again from the [connection page](/docs/get-started/connect).
- **Subagents:** Guardrails follow a subagent that the `task` tool starts. Signed in to GitHub, Copilot would otherwise run a subagent on its own default model, whose requests go to GitHub directly, so the proxy runs it on your session's model instead. A `task` call that names a model outside your Archestra provider is refused, with the models you can use. A background subagent's result reaches your session when Copilot reads it with `read_agent`, also after you send a new prompt while the subagent runs. Subagents from fleet mode or dynamic workflows have no governed parent, and the proxy refuses their model requests.
- **Approvals:** a review shows as Copilot's own question in an interactive session. Copilot loads most MCP tools only when the model searches for them, so the proxy loads the remedy, question, and report tools up front. Copilot's MCP client declines the gateway's form, so a one-shot (`-p`) session cannot answer a review. Setup lets Copilot run the guardrail helpers, such as [`get_remedy_plans`](/docs/reference/archestra-mcp-server#get_remedy_plans), without asking each time.

<a id="session-headers"></a>

## Configure Other Clients

Any other client, such as [n8n](/docs/integrations/web-ui-and-automation#configure-guardrails) or your own app built with an [SDK](/docs/integrations/sdks-and-frameworks#session-ids-for-guardrails), sends the session headers with every model call. Guardrails use them to remember restrictions across turns, tool calls, and retries.

- **`X-Appa-Session-ID`**: your app's conversation ID or workflow run ID. If you do not have one, generate a UUID when the conversation starts and reuse it.
- **`X-Appa-Parent-ID`**: the parent's session ID, when a subagent or child workflow makes the call. Leave it out otherwise.

```bash
export SESSION_ID="$(uuidgen)"

curl "https://archestra.example.com/v1/openai/chat/completions" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "X-Appa-Session-ID: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

Reuse the same ID for the whole conversation, including when you send tool results back. Start a new ID only for a new conversation.

<a id="unrecognized-clients"></a>

## Protection Limits

Guardrails check tool calls that go through the LLM Proxy. They do not cover:

- **Other traffic:** a client that skips the proxy, or sends no session header, is not checked. To refuse such clients, set **Other clients** to **Blocked** in **Settings → Guardrails**.
- **The machine itself:** shell, files, and network are not sandboxed. Run the agent in [Agent Runtime](/docs/agents/runtime) to isolate it.
- **Provider-hosted tools:** a provider's own tools, such as its web search, run before the proxy sees them.
