import type { Page } from "@playwright/test";
import { E2eTestId } from "@shared";
import { expect, goToPage } from "../fixtures";
import { clickButton } from "../utils";

export async function goToMcpRegistry(page: Page): Promise<void> {
  await goToPage(page, "/mcp/registry");
  await page.waitForLoadState("domcontentloaded");
}

export async function openAddMcpServerDialog(page: Page): Promise<void> {
  await clickButton({
    page,
    options: { name: "Add MCP Server" },
  });
  await page.waitForLoadState("domcontentloaded");
}

export async function openRemoteServerForm(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Remote/ }).click();
}

export async function fillRemoteServerForm(
  page: Page,
  params: {
    name: string;
    serverUrl: string;
    authMode?: "none" | "bearer";
  },
): Promise<void> {
  await page.getByRole("textbox", { name: "Name *" }).fill(params.name);
  await page
    .getByRole("textbox", { name: "Server URL *" })
    .fill(params.serverUrl);

  if (params.authMode === "bearer") {
    await page.getByRole("radio", { name: /"Authorization: Bearer/ }).click();
  }
}

export async function submitAddServer(page: Page): Promise<void> {
  await clickButton({ page, options: { name: "Add Server" } });
  await page.waitForLoadState("domcontentloaded");
}

export async function waitForInstallDialog(
  page: Page,
  options?: { titlePattern?: RegExp; timeoutMs?: number },
): Promise<void> {
  const titlePattern = options?.titlePattern ?? /Install -|Install Server/;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  await page
    .getByRole("dialog")
    .filter({ hasText: titlePattern })
    .waitFor({ state: "visible", timeout: timeoutMs });
}

export async function installMcpServer(page: Page): Promise<void> {
  await clickButton({ page, options: { name: "Install" } });
  await page.waitForLoadState("domcontentloaded");
}

export async function waitForMcpServerCard(
  page: Page,
  catalogItemName: string,
): Promise<void> {
  await page
    .getByTestId(`${E2eTestId.McpServerCard}-${catalogItemName}`)
    .waitFor({ state: "visible", timeout: 30_000 });
}

export async function waitForMcpServerToolsDiscovered(
  page: Page,
  catalogItemName?: string,
): Promise<void> {
  const scope = catalogItemName
    ? page.getByTestId(`${E2eTestId.McpServerCard}-${catalogItemName}`)
    : page;

  await scope
    .getByTestId(E2eTestId.McpServerToolsCount)
    .getByText(/\d+/)
    .waitFor({ state: "visible", timeout: 60_000 });
}

export async function openCatalogItemConnectDialog(
  page: Page,
  catalogItemName: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const connectButton = page.getByTestId(
    `${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`,
  );
  await connectButton.waitFor({ state: "visible", timeout: timeoutMs });
  await expect(connectButton).toBeEnabled({ timeout: timeoutMs });
  await connectButton.click({ timeout: timeoutMs });
}
