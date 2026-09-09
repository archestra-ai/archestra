# Chat with an agent

An authorized user can start a browser chat with the intended agent, send a message through a configured model, receive the streamed assistant answer, and reopen the persisted conversation without losing either message.

## Sub-features

- `AGENT-CHAT.NEW` — New Chat renders a usable composer and allows an available agent to be selected before sending.
- `AGENT-CHAT.FROM-AGENT` — the Chat action on an agent card or detail page opens a new chat with that agent selected.
- `AGENT-CHAT.SEND-RECEIVE` — a submitted prompt appears as the user message and a WireMock-backed model response settles as the assistant message.
- `AGENT-CHAT.PERSIST` — the first send creates a `/chat/<conversation-id>` URL, a conversation entry, and a transcript that survives reload/reopen.
- `AGENT-CHAT.BLOCKED-SEND` — drafting stays available while the roster loads, but Submit stays disabled until an agent can be resolved.

## How to get to it (user POV)

- `CHAT-NEW` — AI → **New Chat**, the Archestra logo, or direct route `/chat`.
- `CHAT-AGENT-ACTION` — Studio → Agents → the agent card/table **Chat** action, or the **Chat** button on `/agents/<agent-id>`; the compatibility URL `/chat/new?agent_id=<id>` redirects to `/chat?agentId=<id>`.
- `CHAT-CONVERSATION` — select the created conversation in the AI sidebar or open `/chat/<conversation-id>` directly.

## Driving it with Playwright

Prerequisites: the doctor checks pass; the user has `chat:read` and can read the chosen agent, provider key, and model; the agent is an available internal non-built-in agent; WireMock is healthy for send/receive recipes. Use the real backend provider setup in `ensureWireMockAnthropicChatProvider`; a browser route stub is not equivalent because it bypasses streaming and persistence.

### Select an agent from New Chat

1. Open `/chat` and require `E2eTestId.ChatPromptTextarea` to be visible and editable.
2. Open the agent trigger (`getByRole("combobox").first()` or the element carrying `data-agent-selector`).
3. Require the listbox named **Agents** and search control named **Search agents**. Search for the unique fixture agent.
4. Select its option and require the closed combobox value to equal the fixture name.
5. Fill a draft but do not send. Require the draft value to remain and the selected agent name to stay visible.

Expected result: selecting an available agent changes the target without creating a conversation or sending a prompt. An option labeled **Unavailable** must be disabled and must explain the connection it needs.

### Enter from an agent Chat action

1. Open the unique agent from `/agents` and click the **Chat** link.
2. Require the intermediate link target `/chat/new?agent_id=<agent-id>` to resolve to `/chat?agentId=<agent-id>`.
3. Require `E2eTestId.ChatPromptTextarea` and the agent selector value matching the agent's name.
4. Repeat from the list card/table Chat action. Report `CHAT-AGENT-ACTION` separately for the detail and list entry points.

Do not infer selection solely from the query string; the rendered selector is the observable result.

### Send, receive, and persist

1. Use `ensureWireMockAnthropicChatProvider` to create/reuse the test key, synchronize models, and return its key and runtime model.
2. Open the chat with the intended agent. Select the returned key through `E2eTestId.ChatApiKeySelectorTrigger` and the returned model through `E2eTestId.ChatModelSelectorTrigger` and the **Select Model** dialog.
3. Fill `E2eTestId.ChatPromptTextarea` with `Test message verify-<run-id> chat-ui-e2e-test: Please respond with a simple greeting.` and press Enter once.
4. Require the exact prompt to appear in a user bubble and the WireMock response **This is a mocked response for the chat UI e2e test.** to appear in the first settled assistant bubble within 90 seconds.
5. Require the URL to match `/chat/<uuid>` and capture the UUID. Reload that URL, wait for the composer, and require the same user and assistant text.
6. Open the matching sidebar conversation and require the URL and transcript again. A title can be generated asynchronously; identify it by the unique prompt marker or captured conversation ID rather than assuming title text.

Automated anchors:

- `platform/e2e-tests/tests/chat.spec.ts`, provider-loop test **can send a message and receive a response from Anthropic** covers send/receive through the real browser/backend boundary.
- The same file's **continues a streaming assistant turn after page reload** test covers reconnect and persisted transcript reads.

Report `AGENT-CHAT.SEND-RECEIVE` and `AGENT-CHAT.PERSIST` separately. A visible streamed answer without the reload/reopen second read does not pass persistence.

### Verify the blocked-send boundary

1. Open `/chat`, clear only the run's browser session storage, and hold the agent roster and selected-agent tools/delegations requests pending as `platform/e2e-tests/tests/chat-refresh.spec.ts` does.
2. Reload and require the composer to remain visible and editable.
3. Fill a draft and require it to stay in the textarea.
4. Require the **Submit** button to be disabled and require **No agents yet** not to appear while the roster is still loading.

This recipe deliberately does not send. Release the held routes or close the isolated browser context during cleanup.

## Gotchas

- `/chat/new?agent_id=` is a redirecting compatibility route; the active new-chat route uses `agentId` and the persisted route uses `/chat/<uuid>`.
- The composer can render before the agent roster, tools, and delegations. Editable does not mean sendable; Submit is the authoritative readiness signal.
- The agent's configured model can be inherited from the organization. For deterministic chat evidence, explicitly select the WireMock key and runtime model.
- A configured tool may make an agent unavailable until the current user connects the required MCP server. Do not force-select a disabled option.
- Streaming can take longer under CI contention. Wait on the expected response text and settled transcript, not a fixed sleep.
- The prompt can also become the sidebar title. Scope assertions to the first visible transcript match when necessary.
- Provider-loop success on the default agent does not prove the agent-card/detail entry points. Report each entry point independently.
- Chat tests can leave conversations and provider keys. Keep them in the isolated stack; on an adopted stack, record and remove only run-owned fixtures through supported application APIs.
