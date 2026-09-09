# External A2A agent configuration

An organization administrator can connect an external Agent2Agent system on a routed page, control who can discover and assign it, reopen it from either list view, edit it without replacing an unchanged credential, and remove it from the actions menu.

## Sub-features

- `A2A-OUTBOUND-CONFIG.CREATE` — connecting an external agent from its list produces one routed detail record.
- `A2A-OUTBOUND-CONFIG.EDIT` — connection details and delegation availability persist after saving and reloading the detail page.
- `A2A-OUTBOUND-CONFIG.VISIBILITY` — personal, team, user, and organization access choices persist and govern discovery and assignment.
- `A2A-OUTBOUND-CONFIG.LIST` — cards, table rows, Edit actions, and visibility filters expose the same configured records.
- `A2A-OUTBOUND-CONFIG.RUNTIME` — an accessible, explicitly assigned external target is advertised and can complete a delegated call.

## How to get to it (user POV)

- `A2A-LIST-CREATE` — Studio → Agents → External Agents → **Connect agent**, or direct route `/a2a/agents/new`.
- `A2A-LIST-CARD` — select an external agent card or its **Edit** action.
- `A2A-LIST-ROW` — switch to table view, then select a row, linked name, or its **Edit** action.
- `A2A-DETAIL` — direct route `/a2a/agents/<external-agent-id>`.

## Driving it with Playwright

Prerequisites: the doctor checks pass; the user has `agentSettings:update`; the deterministic A2A fixture is reachable at `A2A_FIXTURE_BASE_URL`; use an isolated stack and a unique `verify-<run-id>` display name.

### Connect and reopen an external agent

1. Open `/a2a/agents`; require the level-1 **External Agents** heading and **Connect agent**.
2. Click Connect agent and require `/a2a/agents/new`, the level-1 **Connect external A2A agent** heading, and no dialog.
3. Paste `A2A_FIXTURE_BASE_URL` into **Agent base URL** and fill a unique display name.
4. Require **Agent Card found** with the deterministic fixture card name, then click **Connect agent** once while waiting for `POST /api/a2a/remote-agents`.
5. Require `/a2a/agents/<id>`, the unique name as the level-1 heading, and the Access controls.
6. Return to `/a2a/agents`, require the named card, select the card body, and require the same detail URL.
7. Return again, switch to table view, select the named row, and require the same detail URL.

Expected result: exactly one external agent exists, creation never opens a modal, and every list entry resolves to its stable detail route. Existing automated anchor: `platform/e2e-tests/tests/outbound-a2a.spec.ts`, test **delegates from a parent agent to an external A2A agent**.

### Save visibility and prove persistence

1. Open the run-owned detail record and capture its initial scope.
2. Select a different scope. For Team choose one run-safe team; for Personal optionally choose one run-safe user. Do not alter the base URL or authentication.
3. Click **Save changes** while waiting for `PUT /api/a2a/remote-agents/<id>`. Require a successful response.
4. Inspect that PUT body and require the intended `scope`, `teams`, and `users`; require it to omit `source` and `auth` when those controls were unchanged.
5. Reload the detail page and require the selected access values.
6. Return to the list, require the matching visibility badge, then exercise the corresponding visibility filter and require the run-owned record to remain.

For authorization coverage, use two real users in the same organization: one inside and one outside the selected visibility. The included user must see the record and be able to assign it from an internal agent's Subagents section. The excluded user must not receive it from list/detail APIs and an assignment POST must reject its ID. Administrators may still manage the connection regardless of visibility.

### Edit without replacing the credential

1. Create a bearer- or API-key-protected run-owned connection through the API, retaining only the fixture secret in test memory.
2. Open its detail page through the card **Edit** action. Require the credential input to be blank and its label to say **Replace credential (optional)**.
3. Change only Description, save, and require the PUT body to omit both `source` and `auth`.
4. Reload and require the new description. Perform one fixture delegation and require success, proving the stored credential was retained.

### Remove from the actions menu

On the list or detail page, open the ellipsis menu for the run-owned record and select **Delete**. Require the confirmation to name the record, confirm while waiting for its DELETE response, and require the record to disappear. Never delete a connection not created by the run.

## Gotchas

- External A2A configuration stores credentials and therefore requires `agentSettings:update`; visibility does not grant credential-management permission.
- Existing records migrate to Organization visibility. Do not use a migrated or shared record to prove the Personal default for newly created connections.
- A blank replacement credential means retain the stored secret. The UI must not send an empty credential or re-resolve an unchanged source during a visibility-only or description-only edit.
- Visibility applies at list, detail, assignment, advertised-tool, dispatch, and run-history boundaries. Proving only the list filter is not authorization coverage.
- External targets remain explicit assignments. Auto subagent mode must not silently discover or add them.
- Creation is not idempotent. Stop retrying once the POST has been dispatched, and let the run-owned record handle cleanup.
