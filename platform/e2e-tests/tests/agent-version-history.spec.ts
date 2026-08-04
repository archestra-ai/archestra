import { E2eTestId } from "@archestra/shared";
import type { Page } from "@playwright/test";
import { goToPage } from "../fixtures";
import { waitForElementWithReload } from "../utils";
import { expect, test } from "./api-fixtures";

// One shared dialog (AgentVersionHistoryDialog) serves agents, MCP gateways,
// and LLM proxies, so the deep flow — browse, compare, restore — runs once
// through the agents page, and the gateway/proxy tests pin only their own
// entry-point wiring. Versions are minted server-side on create (v1) and on
// every config change, so one API update gives a two-version history.

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
  // Not the createAgent fixture: it omits agentType, and the column default is
  // mcp_gateway — such a row never appears on the /agents page.
  const agentResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name: AGENT_NAME,
      teams: [],
      scope: "personal",
      agentType: "agent",
    },
  });
  const agent = await agentResponse.json();

  try {
    // v1 is the creation snapshot; changing the prompt mints v2.
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agent.id}`,
      data: { systemPrompt: "You are the second revision." },
    });

    await goToPage(page, "/agents");

    // The row menu pattern from agents.spec.ts: names are CSS-truncated, so
    // the full string lives on the title attribute, not in visible text.
    const nameCell = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(AGENT_NAME, { exact: true });
    await waitForElementWithReload(page, nameCell, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });
    const row = page
      .getByTestId(E2eTestId.AgentsTable)
      .locator("tr")
      .filter({ has: page.getByTitle(AGENT_NAME, { exact: true }) });
    await row.getByRole("button", { name: /more actions/i }).click();
    await page
      .getByTestId(`${E2eTestId.AgentVersionHistoryButton}-${AGENT_NAME}`)
      .click();

    const dialog = versionHistoryDialog(page);
    await expect(dialog).toBeVisible();

    // Opens on the head (v2), badged as current.
    await expect(
      dialog.getByRole("heading", { name: "Version 2" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /v2/ }).getByText("Current"),
    ).toBeVisible();

    // Compare v2 against v1: the system prompt is what moved.
    await dialog.getByRole("button", { name: /^Changes/ }).click();
    await expect(dialog.getByText("System prompt")).toBeVisible();

    // Restore v1. It lands as a new head (v3) — the history is never
    // rewritten — and the preview jumps to the version just created.
    await dialog.getByRole("button", { name: /v1/ }).click();
    await dialog.getByRole("button", { name: "Restore this version" }).click();
    await page.getByRole("button", { name: "Restore version 1" }).click();

    await expect(
      dialog.getByRole("heading", { name: "Version 3" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      dialog.getByRole("button", { name: /v3/ }).getByText("Current"),
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
  const gatewayResponse = await createMcpGateway(
    request,
    GATEWAY_NAME,
    "personal",
  );
  const gateway = await gatewayResponse.json();

  try {
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${gateway.id}`,
      data: { description: "second revision" },
    });

    await goToPage(page, "/mcp/gateways");

    const historyButton = page.getByTestId(
      `${E2eTestId.AgentVersionHistoryButton}-${GATEWAY_NAME}`,
    );
    await waitForElementWithReload(page, historyButton, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
    });
    await historyButton.click();

    const dialog = versionHistoryDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /v2/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /v1/ })).toBeVisible();
  } finally {
    await deleteAgent(request, gateway.id);
  }
});

test("opens an LLM proxy's version history from its row button", async ({
  page,
  request,
  createLlmProxy,
  deleteAgent,
  makeApiRequest,
}) => {
  test.setTimeout(120_000);

  const PROXY_NAME = `Version History Proxy E2E ${Date.now()}`;
  const proxyResponse = await createLlmProxy(request, PROXY_NAME, "personal");
  const proxy = await proxyResponse.json();

  try {
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${proxy.id}`,
      data: { description: "second revision" },
    });

    await goToPage(page, "/llm/proxies");

    const historyButton = page.getByTestId(
      `${E2eTestId.AgentVersionHistoryButton}-${PROXY_NAME}`,
    );
    await waitForElementWithReload(page, historyButton, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
    });
    await historyButton.click();

    const dialog = versionHistoryDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /v2/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /v1/ })).toBeVisible();
  } finally {
    await deleteAgent(request, proxy.id);
  }
});
