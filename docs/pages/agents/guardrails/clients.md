---
title: Guardrail Clients
sidebarTitle: Clients
description: Make Guardrails check your client, with built-in support or session headers
order: 3
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-11-19
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
- **ChatGPT** desktop app (Work and Codex tabs, see [ChatGPT](#chatgpt))
- **Copilot CLI** (see [Copilot CLI](#copilot-cli) for the providers it works with)
- **Pi**
- **OpenCode**
- **Kilo Code**
- **Kimi Code**
- **Cursor** (see [Use Guardrails in Cursor](#use-guardrails-in-cursor))
- **Grok Build CLI**

Connect the client to the LLM Proxy and the MCP Gateway on the [connection page](/docs/get-started/connect). The client needs both: the LLM Proxy checks each tool call, and the MCP Gateway gives the agent the tools to handle a block, such as [`get_remedy_plans`](/docs/reference/archestra-mcp-server#get_remedy_plans) and [`yell`](/docs/reference/archestra-mcp-server#yell).

### Use Guardrails in Kimi Code

Kimi Code shows a review in its own question form: choose **Inspect**, **Allow**, or **Deny**. **Inspect** shows the complete review, and you then choose **Allow** or **Deny**. Escape closes the form without approving or denying.

- Subagents run under Guardrails only as new foreground `Agent` calls. A background, resumed, or swarm subagent is refused before it starts.
- Setup starts Kimi Code in Ask When Needed mode, so the guardrail helpers run without a prompt. Kimi Code 2.3.3 cannot approve single gateway tools, so this mode also runs your other gateway calls and routine commands without asking. It still asks before dangerous commands and shows reviews.
### Grok Native Tools

Choose **Grok Build** on the connection page, complete setup, and start `grok` in a new terminal. Subscription mode retains native model names, reasoning options and `/model` selection while routing inference through Archestra. This setup configures the CLI, not Grok Bot desktop.

Interactive startup shows configuration, skill sync, model discovery and proxy routing progress on stderr. Routing remains pending server admission; startup is not proof that a session is protected. The first eligible governed reply displays the server-issued `protected session` receipt, as it does for other native clients. This is a reply indicator, not a persistent Grok status-bar badge. Headless prompts skip the screen and check connectivity in the background. Plain output reports status on stdout; JSON output retains native reply fields and adds `_meta.archestraStartup` to the final object. Other quiet and non-terminal runs keep native stdout unchanged. Guardrails checks run in the proxy, never in client hooks.

PowerShell, Bash and Zsh profiles also route Grok's own `agent` command through this launcher. On Unix, both names must resolve to the same executable. An unrelated `agent` command, alias or function keeps its existing behavior. Open a new terminal after connecting to load the managed functions.

On Unix, the managed function replaces any existing `grok` alias in the loaded shell. Its original declaration stays in your profile and takes effect again in a new terminal after disconnecting.

The launcher uses a dedicated profile for native skills and managed hook isolation. Grok reads and refreshes the ordinary native login directly; `/login` and `node ~/.archestra/grok/login.cjs` renew that same login. Credentials are never copied, and conflicting native routing policies stop launch.

Grok's paired provider-hosted web and X search capability is unavailable on this connection. The protected catalog does not advertise it; unsupported tool declarations remain blocked.

Grok's **Opt out** and **Opt in** controls update your xAI coding-data-sharing preference. Changes are audited; a rejected update leaves Grok's cached preference unchanged.

The proxy reads Grok's native session header and checks tool calls before returning them for execution. Shell commands, file reads, edits, writes and searches use the coding-tool policy. The starter policy includes the `target_file` argument binding for Grok reads; existing custom policies are not changed. Other recognized tools still go through policy evaluation. Unknown native tools are refused.

Subagents inherit their parent's labels and return only through a declared return contract. Foreground results, completed background results and native completion notifications pass through the same return checks. Partial, failed and cancelled task output is withheld. Reading raw native session files is refused.

Resuming a completed protected child retains its labels and original return contract, even though Grok assigns it another native ID. Only a verified child of the current parent can be resumed. Workflows, monitors and scheduled execution remain unavailable.

Managed Grok sessions support native direct messages from a parent to its child and between eligible siblings. Guardrails checks the sender, recipient and message before the recipient model reads it. Messages that require different labels stay held until the recipient completes the offered remedy. Delivery acceptance is separate from the child’s checked return. Nested spawning and child-to-root messaging remain unavailable in Grok.

Grok discovers MCP tools through `search_tool` and calls them with `use_tool`. The proxy checks the dispatched target and its arguments, not just the wrapper. Unsigned targets cannot acquire platform remedy authority from their names. Nested dispatchers are refused. The MCP Gateway independently checks the actual call in the same session. Gateway tool names use a Grok-compatible spelling; policy identities and permissions stay unchanged. Interactive Grok sessions can show native approval questions. Headless or unanswered questions never approve a call.

The proxy verifies gateway signatures preserved in Grok's `search_tool` results before treating a deferred tool as a platform tool. It checks the exact target and arguments inside `use_tool`, then returns allowed calls and remedy notices in that same format. A target string alone grants no platform authority. If discovery results are missing after compaction, rediscover the gateway tools before requesting a remedy. Native approval answers bind to the issued question and session; JSON or unrecognized answers do not approve a call.

The protocol was checked with Grok Build 1.0.70, including native login, model selection, resume, skill discovery and synthetic policy reviews. Synthetic upstream checks do not verify paid subscription inference. Directly launching the underlying executable bypasses this connection.

### Use Guardrails in Cursor

Guardrails check every Cursor chat that runs on your computer, and a blocked call never runs. Connect adds a hook to `~/.cursor/hooks.json`, and Cursor asks Archestra about each tool call before it runs. Cursor runs its models in one of two ways:

- **Cursor's own models:** the default. Cursor keeps its models and your Cursor plan, and setup leaves Cursor's model settings alone.
- **Archestra models:** on **Connect**, open **Choose what to include** and turn on **LLM proxy**. Setup points Cursor's OpenAI API key setting at the [Unified Model API](/docs/llm-proxy/unified-model) and lists Archestra's models, such as `anthropic:claude-sonnet-4-6`, in Cursor's model picker. These chats go through the LLM Proxy like any other client's.

Cursor cannot mix the two. Its API key setting covers every model, and Cursor's own models refuse to run with a custom key. So setup switches them off in the picker when it routes models through Archestra. Run setup again with **LLM proxy** off to go back to your Cursor plan.

Quit and reopen Cursor after setup to load the hook. What to know:

- **Archestra must be reachable:** while the hook cannot reach Archestra, Cursor blocks every tool call. For chats on Archestra models, Archestra must be on the internet, because Cursor's servers send those model requests.
- **Approvals:** a review shows as a short form from the MCP gateway in the chat, with **Inspect**, **Allow** and **Deny**. A long value, such as a file's content, shows as its size. Choose **Inspect** and the agent prints the complete review in the chat, then the form comes back. **Allow** is offered only once the form or the chat has shown the whole call. Setup adds the gateway's tool search, its tool runner and the Guardrails tools to Cursor's MCP allowlist in `~/.cursor/permissions.json`, so Cursor does not ask a second time before it runs them.
- **Removing the hook:** a Cursor chat needs your approval to change `~/.cursor/hooks.json` or the files in `~/.cursor/archestra`. A person can still remove their own hook outside Cursor, and their Cursor chats are then not checked.

That allowlist file replaces the MCP allowlist in Cursor's settings. Setup copies the tools you allowed there into the file. If it cannot read them, it leaves the file alone and prints the entries to add by hand.

### How Guardrails Follow a Cursor Chat

Each Cursor chat is its own session, so a restriction in one chat does not reach your other chats. On Cursor's own models, the hook names the chat. On Archestra models, Cursor's servers do not name the chat, so Guardrails follow it on their own:

1. A new chat starts a session named after its first message.
2. Once the chat makes a tool call, the chat gets a session of its own, named after that call. It starts with the restrictions of the first session, and later turns stay in it.

What to know for chats on Archestra models:

- **Edited first message:** if you edit the first message before the chat's first tool call, the chat starts a new session.
- **Same opening:** chats that start with the same first message share a session until each one makes a tool call. After that, a restriction or an approval in one chat does not reach the other.
- **Subagents:** nothing in a subagent's model requests names the chat that started it. Guardrails check a subagent as a chat of its own, so restrictions do not carry between the two. On Cursor's own models they do, as the next section describes.

### Subagents on Cursor's Own Models

A subagent works inside the session of the chat that started it, at any depth. Cursor hands a subagent's answer to its parent without showing it to a hook, so the answer cannot be checked on the way. Sharing the session covers that:

- **Restrictions carry both ways:** a subagent keeps the chat's restrictions, and what a subagent reads restricts the chat. An agent cannot hand a risky read to a subagent to stay unrestricted.
- **No return declaration:** an agent starts a subagent without declaring what it may return. The return rules of other clients do not apply.
- **Approvals:** Cursor shows a subagent's question only inside that subagent's own view. So a subagent hands a call that needs your approval back to the main agent, which asks you in the chat.

### Marks in a Cursor Chat on Cursor's Own Models

Other clients get the `protected session` receipt and the subagent marks written into the reply by Archestra. Cursor gives a hook no way to write into a chat, so the hook asks the model to show each mark and checks the answer Cursor reports afterwards:

- **Session mark:** `protected session` and its code open the first answer that follows a tool call. A chat that calls no tool shows no mark, and has nothing for Guardrails to check.
- **Subagent marks:** `started subagent` and `finished subagent` show in the subagent's own view with one code per subagent: the first after its first tool call, the second as the last line of its reply. A subagent that calls no tool shows none. The main agent is told to leave the mark out when it uses the reply.
- **A missing mark:** the hook repeats the request for the session mark on each tool result until an answer shows it, and stops after three answers without it. Cursor reports no subagent answer to a hook, so a subagent's marks are asked for once and not checked.

The model writes these marks, so a mark is a sign that the hook ran, not proof. The Guardrails log is the record of what was checked.

### Web Search and Fetch in Cursor

A Cursor chat searches the web and reads pages through two tools that Guardrails check before and after each call: `cursor_web_search` and `cursor_web_fetch`. Cursor's own Web Search and Web Fetch call no hook, so setup switches them off and installs these two in their place. The agent finds and uses them without being told.

Each call runs Cursor's own web search or fetch on your Cursor plan, through Cursor's command-line agent. No other search provider is involved. That run is a subagent of the chat, so what it does shows in the chat's Guardrails log. A page on `localhost` or your private network is fetched from your computer instead, because Cursor's servers cannot reach it.

Guardrails rule on the two tools as your policy's web search and URL fetch, with the rules that apply to other coding clients. An output sanitizer can rewrite a result, and a policy can withhold one, because the hook replaces the result before the model reads it.

The connection procedure sets all of it up:

1. Run the setup command from **Connect**. It waits for you to quit Cursor before it switches Cursor's two tools off, because Cursor drops a settings change made while it runs.
2. Approve the browser pages that open. As its last step the command installs Cursor's command-line agent with Cursor's own installer when it is missing, signs it in to Cursor, and then signs it in to the gateway. The agent signs in separately from the Cursor app, so each is a page of its own.
3. Reopen Cursor and paste the prompt from **Connect**. The agent calls `cursor_web_setup`, which finishes the same work from the chat if step 2 did not.

What to know:

- **Cost and speed:** a call is one short run of the command-line agent on Cursor's Auto model: about 17,000 input tokens of your plan and 8 to 12 seconds. A long page comes in parts of about 34,000 characters, and the parts after the first cost no further run.
- **Chats in the command-line agent:** a chat you start with `cursor-agent` loads the same hook, so Guardrails check it, and it needs the gateway for approvals. The agent keeps its gateway sign-in per folder. Setup signs it in for the folder you ran the command in; in another folder, run `cursor-agent mcp login` with the gateway's name.
- **If the command-line agent goes missing or signs out:** the tools tell the model to call `cursor_web_setup`, which installs it or opens the sign-in page for you to approve. Until then the model reads the web with Cursor's browser tool, which Guardrails also check.

If your plan has no Auto model, name a model it has in `ARCHESTRA_CURSOR_WEB_MODELS`, in the `env` of the web tools' server in `~/.cursor/mcp.json`.

### Disconnect Cursor

The cleanup prompt removes everything setup added to Cursor. It runs a script that setup keeps in `~/.cursor/archestra`. Your own servers, hooks, skills and allowlist entries stay in place. Cursor's command-line agent stays installed and signed in to Cursor, even when setup installed it: the cleanup removes only its sign-ins to Archestra's tools.

1. On **Connect**, open **Manage** and press **Disconnect** on Cursor. Paste the prompt into a Cursor chat. The chat runs the cleanup without asking again and reports what it removed.
2. Quit and reopen Cursor. Cursor keeps a settings change only when it is made while Cursor is closed. So the cleanup script waits in the background, for up to a day, and switches **Web Search Tool** and **Web Fetch Tool** back when Cursor closes. You have nothing to run.
3. Press **Revoke access**.

What to know:

- **If Cursor cannot run the prompt:** run the command the dialog shows in a terminal instead. It does the whole cleanup and waits two minutes for you to quit Cursor. Run it also when the two switches are still off after a restart of the computer, which stops the waiting script.
- **If Archestra stops answering part-way:** the chat that runs the cleanup still finishes. Guardrails do not check that chat for ten minutes, and the hook keeps that time. So the chat's steps pass when Archestra is unreachable or access is already revoked.
- **What the cleanup leaves:** text you pasted into **Customize** > **Rules** > **User Rules** and plugins you installed under **Customize** > **Plugins**: remove them there. Cursor also lists what other apps installed, such as Claude Code's plugins in `~/.claude/plugins`. Disconnect that app to remove them.

### What Guardrails Do Not Cover in Cursor

The hook runs in Cursor on your computer, and Cursor gives it a tool's result only after the model has read it. That leaves three gaps:

- **Cursor's own web tools:** Cursor runs its Web Search and Web Fetch without calling the hook. Setup switches them off and installs [checked tools](#web-search-and-fetch-in-cursor) in their place. If you switch **Web Search Tool** or **Web Fetch Tool** back on in Cursor Settings, that tool is not checked. Cursor's command-line agent has the same two tools and no switch for them, so a chat you start there can use them unchecked.
- **Cloud agents:** an agent you start with **Cloud** runs on Cursor's servers and does not load the hook. Its tool calls are not checked.
- **Results of Cursor's own tools:** Guardrails cannot withhold or rewrite what a file read or a shell command returns. A policy's output sanitizer works for MCP tools only. For Cursor's own tools, the agent gets the ruling's other plans, such as accepting the restriction.

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

<a id="chatgpt"></a>

### ChatGPT

Guardrails follow the desktop app's Work and Codex tabs. Both run on your computer and read the Codex settings there. On **Connect**, select **ChatGPT** and run its terminal setup command to route model requests through the LLM Proxy. See [Use Guardrails in the Desktop App](/docs/integrations/ai-clients/chatgpt#use-guardrails-in-the-desktop-app).

- **Not covered:** chats and dots run on OpenAI's servers, so their tool calls never reach the proxy.
- **Approvals:** a review shows as a form from the MCP gateway in the task, as in Codex CLI.

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
- **`X-Archestra-Unattended`**: `1` when no person can answer approvals in the session, so the [Break the glass](/docs/agents/guardrails/policies#yells) settings can let a call that waits for human approval through. Leave it out otherwise.

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
- **Code mode:** the proxy sees only the script, not the tool calls it makes, so Guardrails do not check them. Codex sessions in code mode are refused. In OpenCode, set `"codemode": false` on the gateway's entry under `mcp.servers` so its tools are called directly.
