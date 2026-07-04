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

    const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
    await waitForElementWithReload(page, createButton);

    // The Create-Agent button is server-rendered, so a click that lands before
    // React hydration attaches its onClick handler is silently lost: Playwright
    // reports the click as successful (the SSR button is visible/enabled), but
    // the create dialog never opens and its "Name" field never mounts, so the
    // fill below times out for the life of the page — no retry recovers it.
    // (This was the top remaining merge-queue flake on shard 1; the same
    // pre-hydration lost-click race was fixed for the skills marketplace step
    // in #6339.) Retry the click until the dialog's Name field appears. Opening
    // the dialog is NOT idempotent (a second click would land on the modal
    // overlay), so guard the re-click on the field not already being visible.
    const nameField = page.getByRole("textbox", { name: "Name" });
    await expect(async () => {
      if (!(await nameField.isVisible())) {
        await createButton.click();
      }
      await expect(nameField).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await nameField.fill(AGENT_NAME);

    // Submit the create form. The "Create" button has the same pre-hydration
    // hazard as the dialog trigger above: a click that lands before React
    // wires its submit handler is silently lost, so no POST /api/agents ever
    // fires and the response wait below would time out for the life of the
    // page. Retry the click until the request is actually dispatched.
    // waitForRequest resolves the instant the handler runs, so a click that
    // landed is detected immediately and never re-clicked — there is no window
    // in which a second agent could be created. (Also subsumes the earlier
    // webkit fix: waiting for the POST before polling the table.)
    const submitButton = page.getByRole("button", { name: "Create" });
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
            request.url().includes("/api/agents") &&
            request.method() === "POST",
          { timeout: 3_000 },
        )
        .catch(() => null);
      await submitButton.click();
      expect(await requestDispatched).not.toBeNull();
    }).toPass({ timeout: 20_000 });
    await createResponsePromise;
    await page.waitForLoadState("domcontentloaded");

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

test("can create and delete an LLM proxy", {
  tag: ["@firefox", "@webkit"],
}, async ({ page, makeRandomString, goToPage }) => {
  test.skip(
    true,
    "Currently failing: 'Connect via ...' dialog not visible after create (agents.spec.ts:65)",
  );
  test.setTimeout(120_000);

  const PROXY_NAME = makeRandomString(10, "Test LLM Proxy");
  await goToPage(page, "/llm/proxies");

  await page.waitForLoadState("domcontentloaded");

  const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
  await waitForElementWithReload(page, createButton);
  await createButton.click();
  await page.getByRole("textbox", { name: "Name" }).fill(PROXY_NAME);
  await page.getByRole("button", { name: "Create" }).click();

  // After LLM proxy creation, wait for the connect dialog to appear
  await expect(
    page.getByText(new RegExp(`Connect via.*${PROXY_NAME}`, "i")),
  ).toBeVisible({ timeout: 15_000 });

  // Close the connection dialog by clicking the "Done" button
  await page.getByRole("button", { name: "Done" }).click();

  // Ensure dialog is closed
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded");

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
});

test("can create and delete an MCP gateway", {
  tag: ["@firefox", "@webkit"],
}, async ({ page, makeRandomString, goToPage }) => {
  test.skip(
    true,
    "Currently failing in CI (agents.spec.ts:95 MCP gateway create/delete)",
  );
  test.setTimeout(120_000);

  const GATEWAY_NAME = makeRandomString(10, "Test MCP Gateway");
  await goToPage(page, "/mcp/gateways");

  await page.waitForLoadState("domcontentloaded");

  const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
  await waitForElementWithReload(page, createButton);
  await createButton.click();
  await page.getByRole("textbox", { name: "Name" }).fill(GATEWAY_NAME);
  await page.getByRole("button", { name: "Create" }).click();

  // After MCP gateway creation, wait for the connect dialog to appear
  await expect(
    page.getByText(new RegExp(`Connect via.*${GATEWAY_NAME}`, "i")),
  ).toBeVisible({ timeout: 15_000 });

  // Close the connection dialog by clicking the "Done" button
  await page.getByRole("button", { name: "Done" }).click();

  // Ensure dialog is closed
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded");

  // Poll for the MCP gateway to appear in the table
  const gatewayLocator = page
    .getByTestId(E2eTestId.AgentsTable)
    .getByTitle(GATEWAY_NAME);

  await waitForElementWithReload(page, gatewayLocator, {
    timeout: 30_000,
    intervals: [2000, 3000, 5000],
    checkEnabled: false,
  });

  // Delete created MCP gateway
  await page
    .getByTestId(`${E2eTestId.DeleteAgentButton}-${GATEWAY_NAME}`)
    .click();
  await clickButton({ page, options: { name: "Delete MCP Gateway" } });

  // Wait for deletion to complete
  await expect(gatewayLocator).not.toBeVisible({ timeout: 10000 });
});
