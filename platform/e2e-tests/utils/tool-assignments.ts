import { expect, type Page } from "@playwright/test";
import {
  DEFAULT_MCP_GATEWAY_NAME,
  E2eTestId,
  getAssignmentComboboxDisabledOptionTestId,
  getAssignmentComboboxOptionTestId,
  getAssignmentComboboxSearchInputTestId,
  getAgentToolCatalogPillTestId,
} from "@shared";
import { goToPage } from "../fixtures";
import { clickButton } from "./dialogs";

type AssignmentTarget = {
  page: Page;
  targetName: string;
  catalogItemName: string;
  pagePath: "/agents" | "/mcp/gateways";
  dialogTitle: "Edit Agent" | "Edit MCP Gateway";
};

export async function openAgentCatalogToolAssignment(params: {
  page: Page;
  agentName: string;
  catalogItemName: string;
}) {
  return await openCatalogToolAssignment({
    page: params.page,
    targetName: params.agentName,
    catalogItemName: params.catalogItemName,
    pagePath: "/agents",
    dialogTitle: "Edit Agent",
  });
}

export async function openGatewayCatalogToolAssignment(params: {
  page: Page;
  gatewayName?: string;
  catalogItemName: string;
}) {
  return await openCatalogToolAssignment({
    page: params.page,
    targetName: params.gatewayName ?? DEFAULT_MCP_GATEWAY_NAME,
    catalogItemName: params.catalogItemName,
    pagePath: "/mcp/gateways",
    dialogTitle: "Edit MCP Gateway",
  });
}

export async function saveOpenProfileDialog(page: Page): Promise<void> {
  await clickButton({ page, options: { name: "Save" } });
  await page.waitForLoadState("domcontentloaded");
}

export async function assignCatalogCredentialToGateway(params: {
  page: Page;
  catalogItemName: string;
  credentialName: string;
  gatewayName?: string;
}): Promise<void> {
  await openGatewayCatalogToolAssignment({
    page: params.page,
    catalogItemName: params.catalogItemName,
    gatewayName: params.gatewayName,
  });
  await params.page.getByRole("option", { name: params.credentialName }).click();
  await params.page.keyboard.press("Escape");
  await params.page.waitForTimeout(200);
  await saveOpenProfileDialog(params.page);
}

async function openCatalogToolAssignment({
  page,
  targetName,
  catalogItemName,
  pagePath,
  dialogTitle,
}: AssignmentTarget): Promise<void> {
  await goToPage(page, `${pagePath}?name=${encodeURIComponent(targetName)}`);
  await page.waitForLoadState("domcontentloaded");

  const editButton = page.getByTestId(
    `${E2eTestId.EditAgentButton}-${targetName}`,
  );
  await expect(editButton).toBeVisible({ timeout: 30_000 });
  await editButton.click();

  const dialog = page.getByRole("dialog", { name: dialogTitle });
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  const capabilitiesAnchor = dialog.getByTestId(
    E2eTestId.AgentCapabilitiesSection,
  );
  await capabilitiesAnchor.scrollIntoViewIfNeeded();

  const capabilitiesHeading = dialog.getByRole("heading", {
    name: "Capabilities",
  });
  await expect(capabilitiesHeading).toBeVisible({ timeout: 10_000 });

  const addButton = dialog.getByTestId(E2eTestId.AgentToolsAddButton);
  await expect(addButton).toBeVisible({ timeout: 10_000 });
  await addButton.click();

  const searchInput = page.getByTestId(
    getAssignmentComboboxSearchInputTestId(E2eTestId.AgentToolsAddButton),
  );
  await expect(searchInput).toBeVisible({ timeout: 10_000 });
  await searchInput.fill(catalogItemName);

  const enabledCatalogItem = page.getByTestId(
    getAssignmentComboboxOptionTestId(
      E2eTestId.AgentToolsAddButton,
      catalogItemName,
    ),
  );
  const disabledCatalogItem = page.getByTestId(
    getAssignmentComboboxDisabledOptionTestId(
      E2eTestId.AgentToolsAddButton,
      catalogItemName,
    ),
  );

  await expect
    .poll(
      async () => {
        if (await enabledCatalogItem.isVisible().catch(() => false)) {
          return "enabled";
        }
        if (await disabledCatalogItem.isVisible().catch(() => false)) {
          return "disabled";
        }
        return "missing";
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe("enabled");
  await enabledCatalogItem.click();

  const pillButton = dialog.getByTestId(
    getAgentToolCatalogPillTestId(catalogItemName),
  );
  await expect(pillButton).toBeVisible({ timeout: 10_000 });
  await pillButton.click();

  const tokenSelect = page.getByTestId(E2eTestId.TokenSelect);
  await expect(tokenSelect).toBeVisible({ timeout: 10_000 });
  await tokenSelect.click();
}
