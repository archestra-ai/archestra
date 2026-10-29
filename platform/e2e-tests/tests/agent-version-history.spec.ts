import { E2eTestId } from "@archestra/shared";
import type { Page } from "@playwright/test";
import { goToPage } from "../fixtures";
import {
  clickAgentRowMenuItem,
  waitForAgentsTable,
  waitForElementWithReload,
} from "../utils";
import { expect, test } from "./api-fixtures";

// One shared dialog (AgentVersionHistoryDialog) serves both agents and MCP
// gateways, so the deep flow — browse, compare, restore — runs once through
// the agents page, and the gateway test pins only its own entry-point wiring. Versions are minted server-side on create (v1) and on
// every config change, so one API update gives a two-version history.
//
// Chromium only, unlike the `agents.spec.ts` these share a page with: what is
// under test here is a Monaco diff inside a dialog, and the engine-specific
// risk the `@firefox`/`@webkit` tags exist to cover is carried by that spec's
// coverage of the same page. Running three ~2-minute Monaco flows on every
// engine buys repetition rather than reach.

/** The dialog opened for one entity's history. */
function versionHistoryDialog(page: Page) {
  return page.getByRole("dialog", { name: /Version history/i });
}

test("browses, compares, and restores an agent version from the row menu", async ({
  page,
  request,
  deleteAgent,
  makeApiRequest,
}) => {
  test.setTimeout(120_000);

  const AGENT_NAME = `Version History E2E ${Date.now()}`;
  // Both revisions carry a prompt, so the compare step has text on each side
  // of the diff to assert — a diff against an unset prompt would render only
  // the added half and prove nothing about the comparison.
  const FIRST_PROMPT = "You are the first revision.";
  const SECOND_PROMPT = "You are the second revision.";
  // Not the createAgent fixture: it omits agentType, and the column default is
  // mcp_gateway — such a row never appears on the /agents page.
  const agentResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name: AGENT_NAME,
      agentType: "agent",
      systemPrompt: FIRST_PROMPT,
    },
  });
  const agent = await agentResponse.json();

  try {
    // v1 is the creation snapshot; changing the prompt mints v2.
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agent.id}`,
      data: { systemPrompt: SECOND_PROMPT },
    });

    await goToPage(page, "/agents");
    await waitForAgentsTable(page);

    // Names are CSS-truncated, so the full string lives on the title
    // attribute, not in visible text.
    const nameCell = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(AGENT_NAME, { exact: true });
    await waitForElementWithReload(page, nameCell, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });
    await clickAgentRowMenuItem(page, {
      agentName: AGENT_NAME,
      itemTestId: `${E2eTestId.AgentVersionHistoryButton}-${AGENT_NAME}`,
    });

    const dialog = versionHistoryDialog(page);
    await expect(dialog).toBeVisible();

    // Opens on the head (v2), marked as current on its rail row.
    await expect(
      dialog.getByRole("heading", { name: "Version 2" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /^Version 2 \(current\)/ }),
    ).toBeVisible();

    // Compare v2 against v1: the system prompt is what moved. The dialog opens
    // on Changes, and the control stays disabled until v1 has loaded as the
    // baseline, so the click doubles as the wait for it. Asserted on the
    // unified diff rather than the hunk header, which renders in the "All
    // settings" view too. Only the diff carries both revisions at once, and
    // e2e is the only place real Monaco renders it.
    await dialog.getByRole("button", { name: /^Changes \(/ }).click();
    const unifiedDiff = dialog.getByRole("code").last();
    await expect(unifiedDiff).toContainText(FIRST_PROMPT, { timeout: 15_000 });
    await expect(unifiedDiff).toContainText(SECOND_PROMPT);

    // Restore v1. It lands as a new head (v3) — the history is never
    // rewritten — and the preview jumps to the version just created.
    await dialog.getByRole("button", { name: /^Version 1\b/ }).click();
    await dialog.getByRole("button", { name: "Restore v1" }).click();
    await page.getByRole("button", { name: "Restore version 1" }).click();

    await expect(
      dialog.getByRole("heading", { name: "Version 3" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      dialog.getByRole("button", { name: /^Version 3 \(current\)/ }),
    ).toBeVisible();
  } finally {
    await deleteAgent(request, agent.id);
  }
});

test("opens an MCP gateway's version history from its row button", async ({
  page,
  request,
  createMcpGateway,
  deleteAgent,
  makeApiRequest,
}) => {
  test.setTimeout(120_000);

  const GATEWAY_NAME = `Version History Gateway E2E ${Date.now()}`;
  const gatewayResponse = await createMcpGateway(request, GATEWAY_NAME);
  const gateway = await gatewayResponse.json();

  try {
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${gateway.id}`,
      data: { description: "second revision" },
    });

    await goToPage(page, "/mcp/gateways");
    await waitForAgentsTable(page);

    // Version history sits in the row's "More actions" menu on every entity
    // list, so the row has to arrive before the menu can be opened.
    const nameCell = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(GATEWAY_NAME, { exact: true });
    await waitForElementWithReload(page, nameCell, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });
    await clickAgentRowMenuItem(page, {
      agentName: GATEWAY_NAME,
      itemTestId: `${E2eTestId.AgentVersionHistoryButton}-${GATEWAY_NAME}`,
    });

    const dialog = versionHistoryDialog(page);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /^Version 2\b/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /^Version 1\b/ }),
    ).toBeVisible();
  } finally {
    await deleteAgent(request, gateway.id);
  }
});
