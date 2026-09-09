# Agent configuration

An authorized user can create an internal agent, edit each configuration section, save changes, observe them after a second read, and leave a dirty form without silently losing work.

## Sub-features

- `AGENT-CONFIG.CREATE` — creating an agent from the Agents list produces one routed detail record with a stable UUID.
- `AGENT-CONFIG.GENERAL` — name, model selection, description, instructions, and visibility save from General and persist after reload.
- `AGENT-CONFIG.TOOLS` — tool/knowledge exposure and subagent choices save from Tools & Knowledge and persist after reload.
- `AGENT-CONFIG.MESSAGING-EMPTY` — when no organization messaging provider is configured, Messaging Channels explains the prerequisite and links to the relevant settings instead of presenting false assignments.
- `AGENT-CONFIG.ADVANCED` — environment, suggested prompts, initial sensitive-context behavior, and labels save from Advanced and persist after reload.
- `AGENT-CONFIG.UNSAVED` — leaving a dirty section asks whether to keep editing or discard; discard restores the persisted record.

## How to get to it (user POV)

- `AGENTS-LIST-CREATE` — Studio → Agents → **Create Agent**, or direct route `/agents/new`.
- `AGENTS-LIST-ROW` — Studio → Agents → select the agent card/table row or its **Edit** action.
- `AGENT-DETAIL-TABS` — direct route `/agents/<agent-id>`, then **General**, **Tools & Knowledge**, **Messaging Channels**, or **Advanced**.
- `AGENT-LEGACY-EDIT` — a saved `/agents/<agent-id>/edit?step=<configuration|tools|messaging|advanced>` link redirects to the matching detail section.

## Driving it with Playwright

Prerequisites: the doctor checks pass; the user has `agent:create`, `agent:read`, and `agent:update`; use an internal agent (`agentType: "agent"`), not an MCP gateway or built-in agent. Use a disposable agent on the isolated stack for every saving recipe. Capture the original value before changing any field on an adopted stack.

### Create and reach every section

1. Open `/agents`; require the level-1 **Agents** heading and `E2eTestId.CreateAgentButton`.
2. Click Create Agent and wait for `/agents/new` plus `getByRole("textbox", { name: /^Name\b/ })`.
3. Fill a unique `verify-<run-id>-agent` name. Require `E2eTestId.AgentSetupNextButton` to become enabled.
4. Click Next until `E2eTestId.AgentSetupSubmitButton` is visible, then click it once while waiting for the `POST /api/agents` response.
5. Require a URL matching `/agents/<uuid>?section=connect`, the unique name as a level-1 heading, and text containing `/v2/a2a/<uuid>`.
6. Open each detail tab by role and require its URL and landmark:
   - General: `/agents/<uuid>` and the `Name *` textbox.
   - Tools & Knowledge: `?section=tools` and `E2eTestId.AgentToolsSection`.
   - Messaging Channels: `?section=messaging` and the **Channels** heading.
   - Advanced: `?section=advanced` and the **Environment**, **Suggested prompts**, **Security**, and **Labels** headings.
7. For `AGENT-LEGACY-EDIT`, open `/agents/<uuid>/edit?step=advanced` and require redirect to `/agents/<uuid>?section=advanced`.

Expected result: exactly one new agent exists; every navigation keeps its name in the page heading. Existing automated anchor: `platform/e2e-tests/tests/agents.spec.ts`, test **can create and delete an agent**.

### Save General and prove persistence

1. Open General. Change Description to `verify-<run-id>-description` and Instructions to `Always include verify-<run-id> in the answer.` using the labeled controls. Leave model and visibility unchanged unless those fields are the behavior under test.
2. Require **Save changes** to become enabled, click it, and require the toast **Agent updated successfully**.
3. Reload the detail URL. Require the description and instructions to equal the saved markers and Save changes to be disabled.
4. Navigate back to `/agents`; require the updated description on the matching card or row, then reopen the detail and perform the same second read.

For model persistence, choose the API key first when the UI presents separate key/model controls, select a model from the **Select Model** dialog, save, reload, and require both displayed choices. Do not claim model coverage when the organization default merely renders as a disabled inherited value.

### Save Tools & Knowledge and prove persistence

1. Open Tools & Knowledge and scope all locators under `E2eTestId.AgentToolsSection`.
2. Capture whether the Tools control is on **All** or **Manual** and the visible enabled/disabled count.
3. Switch to the other tab. In Manual mode, assign one known fixture tool; in All mode, disable one known fixture tool. Avoid tools owned by another concurrent run.
4. Save, require **Agent updated successfully**, and reload `?section=tools`.
5. Require the chosen mode and the named tool/count to match. Reopen General and return to Tools & Knowledge for a second routed read.
6. Restore the original mode and assignment before deleting the fixture or leaving an adopted stack.

If no deterministic MCP fixture is installed, mark the assignment part Blocked and test mode persistence only; do not relabel it as full `AGENT-CONFIG.TOOLS` coverage.

### Verify empty Messaging Channels

Open Messaging Channels on an organization with no configured provider. Require **No messaging providers connected**, links named **Connect MS Teams**, **Connect Slack**, and **Connect Telegram**, plus **Incoming email isn't set up** and **Set up email in Settings**. Save changes must remain disabled. This recipe covers only the empty prerequisite state; configured channel assignment and message delivery remain unmapped.

### Save Advanced and prove persistence

1. Open Advanced. Capture the current value of the switch **Treat context as sensitive from the start of chat**.
2. Toggle it, save, require **Agent updated successfully**, reload, and require the new value.
3. Add one label with `Label key` and `Label value`, save, reload, and require the key/value pair.
4. If suggested prompts are in scope, click **Add**, fill **Button Label** and **Suggested prompt** within the displayed limits, save, reload, and require both values.
5. Restore the captured switch value and remove the run-owned label/prompt before leaving an adopted stack.

### Protect unsaved changes

This is the safe configuration smoke test for an adopted stack.

1. Open General on a pre-existing editable agent and capture its Description.
2. Fill Description with `Temporary verify-<run-id> draft — do not save`; require Save changes to become enabled.
3. Click Tools & Knowledge. Require a dialog named **Discard unsaved changes?** with **Keep editing** and **Discard changes**.
4. Click Keep editing. Require the General URL and draft value to remain.
5. Attempt the tab change again and click Discard changes. Require the Tools & Knowledge URL.
6. Return to General and require the original Description and a disabled Save changes button.

Capture the dialog and final second read as evidence. This recipe must not click Save changes.

## Gotchas

- The list and wizard controls can appear before React hydration. Retry only idempotent actions and stop retrying a create click as soon as its POST is dispatched; otherwise duplicate agents are possible.
- Agent configuration is edited in-place on the detail page. The old `/edit?step=` route is a compatibility redirect, not a second editor.
- General, Tools & Knowledge, Messaging Channels, and Advanced mount separate form groups. Saving one must not be assumed to prove another.
- Built-in agents, MCP gateways, unavailable providers, missing knowledge embeddings, missing messaging providers, permissions, and ownership change which controls render or are enabled.
- New agents default to automatic tool exposure. A count can describe disabled tools rather than assigned tools; record the selected mode with the count.
- A success toast is only the first observation. Reload and reopen from the list to prove persistence.
- Deleting an agent is destructive. Let the isolated automated fixture own cleanup; never delete the default or another user's agent.
