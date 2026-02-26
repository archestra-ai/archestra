import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";
import { clickButton, waitForElementWithReload } from "../../utils";

test(
  "can create and delete an agent",
  { tag: ["@firefox", "@webkit"] },
  async ({ page, makeRandomString, goToPage }) => {
    test.setTimeout(120_000);

    const AGENT_NAME = makeRandomString(10, "Test Agent");
    await goToPage(page, "/agents");

    await page.waitForLoadState("domcontentloaded");

    const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
    await waitForElementWithReload(page, createButton);
    await createButton.click();
    await page.getByRole("textbox", { name: "Name" }).fill(AGENT_NAME);
    await page.getByRole("button", { name: "Create" }).click();

    // Wait for the create dialog to close
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("domcontentloaded");

    // Poll for the agent to appear in the table
    const agentLocator = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByText(AGENT_NAME);

    await waitForElementWithReload(page, agentLocator, {
      timeout: 30_000,
      intervals: [2000, 3000, 5000],
      checkEnabled: false,
    });

    // Delete created agent
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
  { tag: ["@firefox", "@webkit"] },
  async ({ page, makeRandomString, goToPage }) => {
    test.setTimeout(120_000);

    const PROXY_NAME = makeRandomString(10, "Test LLM Proxy");
    await goToPage(page, "/llm-proxies");

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
      .getByText(PROXY_NAME);

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
  "can create and delete an MCP gateway",
  { tag: ["@firefox", "@webkit"] },
  async ({ page, makeRandomString, goToPage }) => {
    test.setTimeout(120_000);

    const GATEWAY_NAME = makeRandomString(10, "Test MCP Gateway");
    await goToPage(page, "/mcp-gateways");

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
      .getByText(GATEWAY_NAME);

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
  },
);
