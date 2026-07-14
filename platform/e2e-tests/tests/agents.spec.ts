import { E2eTestId } from "@archestra/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { clickButton, waitForElementWithReload } from "../utils";

// Delete and Clone actions live inside the row's "More actions" dropdown
// (see frontend/src/app/agents/agent-actions.tsx). The dropdown content is
// only mounted when the trigger is clicked, so we open it before clicking
// the test-id'd action. We scope by the agent-name title cell rather than
// row accessible name, because the DataTable truncates names with CSS
// (the full string lives on the title attribute, not in visible text).
async function openAgentRowMenu(page: Page, agentName: string): Promise<void> {
  const row = page
    .getByTestId(E2eTestId.AgentsTable)
    .locator("tr")
    .filter({
      has: page.getByTitle(agentName, { exact: true }),
    });
  await row.getByRole("button", { name: /more actions/i }).click();
}

/**
 * Drive the shared creation dialog (AgentDialog) to a submitted POST.
 *
 * The dialog's trigger, name input, and submit button render before React
 * finishes hydrating, so any interaction landing in that window is silently
 * lost — Playwright sees a visible/enabled element and reports success, but
 * the handler never ran. A longer timeout can't recover a dropped
 * interaction, so each step is driven by its observable end-state and
 * retried until that state is reached. (Same pre-hydration class as the
 * skills marketplace fix in #6339.)
 */
async function createViaDialog(
  page: Page,
  dialogTitle: RegExp,
  name: string,
): Promise<void> {
  const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
  await waitForElementWithReload(page, createButton);

  const dialog = page.getByRole("dialog", { name: dialogTitle });
  const nameField = dialog.getByRole("textbox", { name: "Name" });
  const submitButton = dialog.getByRole("button", { name: "Create" });

  // 1. Open the dialog — retry the trigger until the name field mounts.
  //    Guarded on visibility so a landed click is never re-sent through the
  //    modal overlay (opening the dialog is not idempotent).
  await expect(async () => {
    if (!(await nameField.isVisible())) {
      await createButton.click();
    }
    await expect(nameField).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

  // 2. Fill the name — retry until the form actually registered it, which the
  //    Create button becoming enabled confirms (it is disabled while the name
  //    is empty). fill() is idempotent, so re-filling after the input hydrates
  //    is safe and is what flips the button from disabled to enabled.
  await expect(async () => {
    await nameField.fill(name);
    await expect(submitButton).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // 3. Submit — retry the click until the POST is dispatched. waitForRequest
  //    resolves the instant the handler runs, so a click that landed is
  //    detected immediately and never re-clicked — there is no window in which
  //    a second agent could be created.
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/agents") &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await expect(async () => {
    const requestDispatched = page
      .waitForRequest(
        (request) =>
          request.url().includes("/api/agents") && request.method() === "POST",
        { timeout: 3_000 },
      )
      .catch(() => null);
    await submitButton.click();
    expect(await requestDispatched).not.toBeNull();
  }).toPass({ timeout: 20_000 });
  await createResponsePromise;
  await page.waitForLoadState("domcontentloaded");
}

test(
  "can create and delete an agent",
  {
    tag: ["@firefox", "@webkit"],
  },
  async ({ page, makeRandomString, goToPage }, testInfo) => {
    // webkit intermittently fails: delete doesn't propagate before the next
    // assertion, then create-agent-button isn't found on retry. Tracked
    // alongside MQ flakiness from https://github.com/archestra-ai/archestra/actions/runs/26282803981.
    test.skip(testInfo.project.name === "webkit", "flaky on webkit");
    test.setTimeout(120_000);

    const AGENT_NAME = makeRandomString(10, "Test Agent");
    await goToPage(page, "/agents");

    await page.waitForLoadState("domcontentloaded");

    await createViaDialog(page, /Create Agent/i, AGENT_NAME);

    // Creation hands off to the agent's connect dialog so the user knows how
    // to use it; close it to get back to the table.
    const connectDialog = page.getByRole("dialog", {
      name: new RegExp(`Connect to "${AGENT_NAME}"`, "i"),
    });
    await expect(connectDialog).toBeVisible({ timeout: 15_000 });
    await connectDialog.getByRole("button", { name: "Done" }).click();
    await expect(connectDialog).not.toBeVisible({ timeout: 10_000 });

    // Poll for the agent to appear in the table
    const agentLocator = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(AGENT_NAME);

    await waitForElementWithReload(page, agentLocator, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });

    // Delete created agent
    await openAgentRowMenu(page, AGENT_NAME);
    await page
      .getByTestId(`${E2eTestId.DeleteAgentButton}-${AGENT_NAME}`)
      .click();
    await clickButton({ page, options: { name: "Delete Agent" } });

    // Wait for deletion to complete
    await expect(agentLocator).not.toBeVisible({ timeout: 10000 });
  },
);

test(
  "can create and delete an LLM proxy",
  {
    tag: ["@firefox", "@webkit"],
  },
  async ({ page, makeRandomString, goToPage }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "flaky on webkit");
    test.setTimeout(120_000);

    const PROXY_NAME = makeRandomString(10, "Test LLM Proxy");
    await goToPage(page, "/llm/proxies");

    await page.waitForLoadState("domcontentloaded");

    await createViaDialog(page, /Create LLM Proxy/i, PROXY_NAME);

    // Creation hands off to the post-create connect dialog.
    const postCreateDialog = page.getByTestId(
      E2eTestId.PostCreateConnectDialog,
    );
    await expect(postCreateDialog).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(E2eTestId.PostCreateOpenConnectionGuideButton),
    ).toBeVisible();
    await page.getByTestId(E2eTestId.PostCreateConnectDoneButton).click();
    await expect(postCreateDialog).not.toBeVisible({ timeout: 10_000 });

    // Poll for the LLM proxy to appear in the table
    const proxyLocator = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(PROXY_NAME);

    await waitForElementWithReload(page, proxyLocator, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });

    // Delete created LLM proxy
    await page
      .getByTestId(`${E2eTestId.DeleteAgentButton}-${PROXY_NAME}`)
      .click();
    await clickButton({ page, options: { name: "Delete LLM Proxy" } });

    // Wait for deletion to complete
    await expect(proxyLocator).not.toBeVisible({ timeout: 10000 });
  },
);

test(
  "can create an MCP gateway and land on the pre-selected connection guide",
  {
    tag: ["@firefox", "@webkit"],
  },
  async ({ page, makeRandomString, goToPage }, testInfo) => {
    test.skip(testInfo.project.name === "webkit", "flaky on webkit");
    test.setTimeout(120_000);

    const GATEWAY_NAME = makeRandomString(10, "Test MCP Gateway");
    await goToPage(page, "/mcp/gateways");

    await page.waitForLoadState("domcontentloaded");

    await createViaDialog(page, /Create MCP Gateway/i, GATEWAY_NAME);

    // Creation hands off to the post-create connect dialog; the primary CTA
    // lands on /connection with the new gateway pre-selected.
    const postCreateDialog = page.getByTestId(
      E2eTestId.PostCreateConnectDialog,
    );
    await expect(postCreateDialog).toBeVisible({ timeout: 15_000 });
    await page
      .getByTestId(E2eTestId.PostCreateOpenConnectionGuideButton)
      .click();
    await page.waitForURL(/\/connection\?gatewayId=.*&from=create/, {
      timeout: 15_000,
    });

    // Clean up: back to the table and delete the gateway.
    await goToPage(page, "/mcp/gateways");
    const gatewayLocator = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByTitle(GATEWAY_NAME);

    await waitForElementWithReload(page, gatewayLocator, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });

    await page
      .getByTestId(`${E2eTestId.DeleteAgentButton}-${GATEWAY_NAME}`)
      .click();
    await clickButton({ page, options: { name: "Delete MCP Gateway" } });

    // Wait for deletion to complete
    await expect(gatewayLocator).not.toBeVisible({ timeout: 10000 });
  },
);
