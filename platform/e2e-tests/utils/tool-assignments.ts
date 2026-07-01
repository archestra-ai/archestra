import {
  E2eTestId,
  getAgentToolCatalogPillTestId,
  getAssignmentComboboxDisabledOptionTestId,
  getAssignmentComboboxOptionTestId,
  getAssignmentComboboxSearchInputTestId,
} from "@archestra/shared";
import { expect, type Page } from "@playwright/test";
import { goToPage } from "../fixtures";

type AssignmentTarget = {
  page: Page;
  targetName: string;
  catalogItemName: string;
  pagePath: "/agents" | "/mcp/gateways";
  dialogTitle: "Edit Agent" | "Edit MCP Gateway";
};

export async function openGatewayCatalogToolAssignment(params: {
  page: Page;
  gatewayName: string;
  catalogItemName: string;
}) {
  return await openCatalogToolAssignment({
    page: params.page,
    targetName: params.gatewayName,
    catalogItemName: params.catalogItemName,
    pagePath: "/mcp/gateways",
    dialogTitle: "Edit MCP Gateway",
  });
}

export async function saveOpenProfileDialog(page: Page): Promise<void> {
  const saveButton = page.getByRole("button", { name: "Save" });
  const updateButton = page.getByRole("button", { name: "Update" });

  if (await saveButton.isVisible().catch(() => false)) {
    await saveButton.click();
  } else {
    await expect(updateButton).toBeVisible({ timeout: 15_000 });
    await updateButton.click();
  }

  await page.waitForLoadState("domcontentloaded");
}

export async function assignCatalogCredentialToGateway(params: {
  page: Page;
  catalogItemName: string;
  credentialName: string;
  gatewayName: string;
}): Promise<void> {
  await openGatewayCatalogToolAssignment({
    page: params.page,
    catalogItemName: params.catalogItemName,
    gatewayName: params.gatewayName,
  });
  const credentialOption = params.page.getByRole("option", {
    name: params.credentialName,
  });
  await expect(credentialOption).toBeVisible({ timeout: 10_000 });
  // Same DOM-detach issue as the visibleTokenSelect click above — the
  // capability row re-renders briefly when the credential dropdown opens.
  await credentialOption.click({ force: true });
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
  const visibleTokenSelect = page.getByTestId(E2eTestId.TokenSelect).last();
  const pillButtonByTestId = page.getByTestId(
    getAgentToolCatalogPillTestId(catalogItemName),
  );
  const pillButtonByRole = page.getByRole("button", {
    name: new RegExp(escapeRegExp(catalogItemName)),
  });

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

  type CatalogAssignmentState =
    | "token-select"
    | "pill-testid"
    | "pill-role"
    | "enabled"
    | "disabled"
    | "missing";
  // Widen the literal initializer to the full union: TS narrows `let` vars
  // initialized with a literal to that literal type and does not widen the
  // narrowing when the variable is mutated only through a captured closure
  // (like the expect.poll callback below). Casting the initializer prevents
  // narrowing from the start so subsequent comparisons type-check correctly.
  let catalogAssignmentState = "missing" as CatalogAssignmentState;

  await expect
    .poll(
      async () => {
        if (await visibleTokenSelect.isVisible().catch(() => false)) {
          catalogAssignmentState = "token-select";
          return catalogAssignmentState;
        }
        if (await pillButtonByTestId.isVisible().catch(() => false)) {
          catalogAssignmentState = "pill-testid";
          return catalogAssignmentState;
        }
        if (await pillButtonByRole.isVisible().catch(() => false)) {
          catalogAssignmentState = "pill-role";
          return catalogAssignmentState;
        }
        if (await enabledCatalogItem.isVisible().catch(() => false)) {
          catalogAssignmentState = "enabled";
          return catalogAssignmentState;
        }
        if (await disabledCatalogItem.isVisible().catch(() => false)) {
          catalogAssignmentState = "disabled";
          return catalogAssignmentState;
        }
        catalogAssignmentState = "missing";
        return catalogAssignmentState;
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .not.toBe("missing");

  if (catalogAssignmentState === "enabled") {
    await enabledCatalogItem.click();
    // Close the combobox only if it stayed open — pressing Escape
    // unconditionally can close the outer Edit dialog when the combobox has
    // already collapsed on click, which leaves the assignment in "missing".
    if (await searchInput.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
    }
  }

  try {
    await expect(visibleTokenSelect).toBeVisible({ timeout: 15_000 });
  } catch {
    await expect
      .poll(
        async () => {
          if (await visibleTokenSelect.isVisible().catch(() => false)) {
            return "token-select";
          }
          if (await pillButtonByTestId.isVisible().catch(() => false)) {
            return "pill-testid";
          }
          if (await pillButtonByRole.isVisible().catch(() => false)) {
            return "pill-role";
          }
          return "missing";
        },
        { timeout: 20_000, intervals: [500, 1000, 2000, 4000] },
      )
      .not.toBe("missing");

    if (await pillButtonByTestId.isVisible().catch(() => false)) {
      await pillButtonByTestId.click({ force: true });
    } else if (await pillButtonByRole.isVisible().catch(() => false)) {
      await pillButtonByRole.click({ force: true });
    }

    await expect(visibleTokenSelect).toBeVisible({ timeout: 15_000 });
  }

  // Surrounding capability rows re-render briefly when the catalog selection
  // commits — observed "element was detached / not stable" failures here.
  // Force the click since visibility is already asserted above.
  await visibleTokenSelect.click({ force: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
