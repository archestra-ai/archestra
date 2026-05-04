import type { Page } from "@playwright/test";
import {
  E2eTestId,
  getManageCredentialsAddToTeamOptionTestId,
  getManageCredentialsButtonTestId,
} from "@shared";
import { expect, goToPage } from "../fixtures";
import { clickButton, closeOpenDialogs } from "./dialogs";
import { openManageCredentialsDialog } from "./mcp-gateway";

export async function goToMcpRegistry(page: Page): Promise<void> {
  await goToPage(page, "/mcp/registry");
  await page.waitForLoadState("domcontentloaded");
}

async function filterMcpRegistryByName(
  page: Page,
  catalogItemName: string,
): Promise<void> {
  const searchInput = page.getByRole("textbox", {
    name: "Search MCP servers by name",
  });
  await expect(searchInput).toBeVisible({ timeout: 10_000 });
  await searchInput.fill(catalogItemName);
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

async function _selectTeamCredentialType(
  page: Page,
  teamName: string,
): Promise<void> {
  await page.getByTestId(E2eTestId.SelectCredentialTypeTeamDropdown).click();
  await page.getByRole("option", { name: teamName }).click();
}

export async function waitForMcpServerCard(
  page: Page,
  catalogItemName: string,
): Promise<void> {
  await filterMcpRegistryByName(page, catalogItemName);
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
  const toolsCount = scope
    .getByTestId(E2eTestId.McpServerToolsCount)
    .getByText(/\d+/);
  const errorBanner = catalogItemName
    ? scope.getByTestId(`${E2eTestId.McpServerError}-${catalogItemName}`)
    : page.locator("[data-testid^='mcp-server-error-']").first();

  await expect
    .poll(
      async () => {
        if (await toolsCount.isVisible().catch(() => false)) {
          return { state: "ready" as const };
        }

        if (await errorBanner.isVisible().catch(() => false)) {
          return {
            state: "error" as const,
            message: (await errorBanner.textContent().catch(() => "")) ?? "",
          };
        }

        return { state: "pending" as const };
      },
      { timeout: 120_000, intervals: [500, 1000, 2000, 5000] },
    )
    .toMatchObject({ state: "ready" });
}

async function openCatalogItemConnectDialog(
  page: Page,
  catalogItemName: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  await filterMcpRegistryByName(page, catalogItemName);
  const connectButton = page.getByTestId(
    `${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`,
  );
  await connectButton.waitFor({ state: "visible", timeout: timeoutMs });
  await expect(connectButton).toBeEnabled({ timeout: timeoutMs });
  await connectButton.click({ timeout: timeoutMs });
}

export async function installLocalCatalogItem(params: {
  page: Page;
  catalogItemName: string;
  envValues?: Record<string, string>;
  expectDialog?: boolean;
  vaultSecretName?: string;
  vaultSecretKey?: string;
  timeoutMs?: number;
}): Promise<void> {
  await openCatalogItemConnectDialog(params.page, params.catalogItemName, {
    timeoutMs: params.timeoutMs,
  });

  const shouldWaitForDialog =
    params.expectDialog ?? Object.keys(params.envValues ?? {}).length > 0;
  if (!shouldWaitForDialog) {
    if (await maybeWaitForInstallDialog(params.page, params.timeoutMs)) {
      await installMcpServer(params.page);
      await waitForInstalledCardActions(params.page, params.catalogItemName);
      await waitForMcpServerToolsDiscovered(
        params.page,
        params.catalogItemName,
      );
    }
    return;
  }

  await waitForInstallDialog(params.page, { timeoutMs: params.timeoutMs });

  await maybeSelectVaultSecret(params.page, {
    secretName: params.vaultSecretName,
    secretKey: params.vaultSecretKey,
  });
  await fillInstallDialogEnvValues(params.page, params.envValues);

  await installMcpServer(params.page);
  await waitForInstalledCardActions(params.page, params.catalogItemName);
  await waitForMcpServerToolsDiscovered(params.page, params.catalogItemName);
}

export async function addSharedLocalConnection(params: {
  page: Page;
  catalogItemName: string;
  teamName: string;
  envValues?: Record<string, string>;
  expectDialog?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  await openManageCredentialsDialog(params.page, params.catalogItemName);
  const visibleDialog = params.page
    .getByRole("dialog")
    .filter({ visible: true })
    .last();
  await visibleDialog
    .getByRole("button", { name: /^Install\b/ })
    .click({ timeout: params.timeoutMs ?? 15_000 });
  await params.page
    .getByTestId(getManageCredentialsAddToTeamOptionTestId(params.teamName))
    .click({ timeout: params.timeoutMs ?? 15_000 });

  const shouldWaitForDialog =
    params.expectDialog ?? Object.keys(params.envValues ?? {}).length > 0;
  if (!shouldWaitForDialog) {
    if (await maybeWaitForInstallDialog(params.page, params.timeoutMs)) {
      await installMcpServer(params.page);
      await waitForInstalledCardActions(params.page, params.catalogItemName);
      await waitForMcpServerToolsDiscovered(
        params.page,
        params.catalogItemName,
      );
      return;
    }

    await expect(
      visibleDialog.getByTestId(
        E2eTestId.ManageCredentialsSharedConnectionsEmptyState,
      ),
    ).not.toBeVisible({
      timeout: params.timeoutMs ?? 15_000,
    });
    return;
  }

  await waitForInstallDialog(params.page, { timeoutMs: params.timeoutMs });

  await fillInstallDialogEnvValues(params.page, params.envValues);

  await installMcpServer(params.page);
  await waitForInstalledCardActions(params.page, params.catalogItemName);
  await waitForMcpServerToolsDiscovered(params.page, params.catalogItemName);
}

export async function settleRegistryAfterInstall(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await closeOpenDialogs(page, { timeoutMs: 15_000 });
}

async function fillInstallDialogEnvValues(
  page: Page,
  envValues?: Record<string, string>,
): Promise<void> {
  for (const [key, value] of Object.entries(envValues ?? {})) {
    const input = page.getByRole("textbox", { name: key });
    if (!(await input.isVisible().catch(() => false))) {
      continue;
    }
    await expect(input).toBeEnabled({ timeout: 15_000 });
    await input.fill(value);
  }
}

async function maybeWaitForInstallDialog(
  page: Page,
  timeoutMs?: number,
): Promise<boolean> {
  try {
    await waitForInstallDialog(page, {
      timeoutMs: Math.min(timeoutMs ?? 5_000, 5_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function maybeSelectVaultSecret(
  page: Page,
  params?: {
    secretName?: string;
    secretKey?: string;
  },
): Promise<void> {
  const folderTrigger = page.getByRole("combobox").filter({
    has: page.getByText("-- Select Vault folder --"),
  });

  if (!(await folderTrigger.isVisible().catch(() => false))) {
    return;
  }

  await folderTrigger.click();
  const vaultFolderOption = page.getByRole("option").first();
  await expect(vaultFolderOption).toBeVisible({ timeout: 15_000 });
  await vaultFolderOption.click();

  const secretTrigger = page.getByTestId(
    E2eTestId.InlineVaultSecretSelectorSecretTrigger,
  );
  if (!(await secretTrigger.isVisible().catch(() => false))) {
    return;
  }
  await secretTrigger.click();
  if (params?.secretName) {
    await page.getByRole("option", { name: params.secretName }).click();
  } else {
    await page.getByRole("option").nth(1).click();
  }

  const secretKeyTrigger = page.getByTestId(
    E2eTestId.InlineVaultSecretSelectorSecretTriggerKey,
  );
  await expect(secretKeyTrigger).toBeVisible({ timeout: 15_000 });
  await secretKeyTrigger.click();
  if (params?.secretKey) {
    await page.getByRole("option", { name: params.secretKey }).click();
  } else {
    await page.getByRole("option").nth(1).click();
  }
}

async function waitForInstalledCardActions(
  page: Page,
  catalogItemName: string,
): Promise<void> {
  await filterMcpRegistryByName(page, catalogItemName);
  const targetCard = page.getByTestId(
    `${E2eTestId.McpServerCard}-${catalogItemName}`,
  );
  const manageButton = targetCard.getByTestId(
    getManageCredentialsButtonTestId(catalogItemName),
  );
  const deploymentButton = targetCard.getByRole("button", {
    name: /^\d+\/\d+$/,
  });
  const uninstallButton = targetCard.getByRole("button", { name: "Uninstall" });
  const progressBar = targetCard.getByRole("progressbar");

  await expect
    .poll(
      async () =>
        !(await progressBar.isVisible().catch(() => false)) &&
        ((await manageButton.isVisible().catch(() => false)) ||
          (await deploymentButton.isVisible().catch(() => false)) ||
          (await uninstallButton.isVisible().catch(() => false))),
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}
