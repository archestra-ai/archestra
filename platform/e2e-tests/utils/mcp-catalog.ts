import type { APIRequestContext, Page } from "@playwright/test";
import { archestraApiSdk } from "@shared";
import { testMcpServerCommand } from "@shared/test-mcp-server";
import { API_BASE_URL, E2eTestId, UI_BASE_URL } from "../consts";
import { goToPage } from "../fixtures";

export async function addCustomSelfHostedCatalogItem({
  page,
  cookieHeaders,
  catalogItemName,
  envVars,
  scope,
}: {
  page: Page;
  cookieHeaders: string;
  catalogItemName: string;
  envVars?: {
    key: string;
    promptOnInstallation: boolean;
    isSecret?: boolean;
    vaultSecret?: {
      name: string;
      key: string;
      value: string;
      teamName: string;
    };
  };
  scope?: "personal" | "team" | "org";
}) {
  await goToPage(page, "/mcp/registry");
  await page.waitForLoadState("domcontentloaded");
  const addButton = page.getByRole("button", { name: "Add MCP Server" });
  await addButton.waitFor({ state: "visible", timeout: 30_000 });
  await addButton.click();

  await page.getByRole("button", { name: "Self-hosted" }).click();
  await page.getByRole("textbox", { name: "Name *" }).fill(catalogItemName);
  await page.getByRole("textbox", { name: "Command" }).fill("sh");
  const singleLineCommand = testMcpServerCommand.replace(/\n/g, " ");
  await page
    .getByRole("textbox", { name: "Arguments (one per line)" })
    .fill(`-c\n${singleLineCommand}`);
  if (envVars) {
    await page.getByRole("button", { name: "Add Variable" }).click();
    await page.getByRole("textbox", { name: "API_KEY" }).fill(envVars.key);
    if (envVars.isSecret) {
      await page.getByTestId(E2eTestId.SelectEnvironmentVariableType).click();
      await page.getByRole("option", { name: "Secret" }).click();
    }
    if (envVars.promptOnInstallation) {
      await page
        .getByTestId(E2eTestId.PromptOnInstallationCheckbox)
        .click({ force: true });
    }
    if (envVars.vaultSecret) {
      await page.getByText("Set Secret").click();
      await page
        .getByTestId(E2eTestId.ExternalSecretSelectorTeamTrigger)
        .click();
      await page
        .getByRole("option", { name: envVars.vaultSecret.teamName })
        .click();
      await page
        .getByTestId(E2eTestId.ExternalSecretSelectorSecretTrigger)
        .click();
      await page.getByText(envVars.vaultSecret.name).click();
      await page
        .getByTestId(E2eTestId.ExternalSecretSelectorSecretTriggerKey)
        .click();
      await page.getByRole("option", { name: envVars.vaultSecret.key }).click();
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.waitForTimeout(2_000);
    }
  }
  if (scope && scope !== "personal") {
    await page
      .getByRole("button", { name: /Only you can access this MCP server/i })
      .click();
    const scopeLabel = scope === "org" ? "Organization" : "Teams";
    await page
      .getByRole("button", { name: new RegExp(scopeLabel, "i") })
      .click();
  }
  await page.getByRole("button", { name: "Add Server" }).click();
  await page.waitForLoadState("domcontentloaded");

  await page
    .getByRole("dialog")
    .filter({ hasText: /Install -/ })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  const catalogItems = await archestraApiSdk.getInternalMcpCatalog({
    headers: { Cookie: cookieHeaders },
  });

  if (catalogItems.error) {
    throw new Error(
      `Failed to get catalog items: ${JSON.stringify(catalogItems.error)}`,
    );
  }
  if (!catalogItems.data || catalogItems.data.length === 0) {
    throw new Error(
      `No catalog items returned from API. Response: ${JSON.stringify(catalogItems)}`,
    );
  }

  const newCatalogItem = catalogItems.data.find(
    (item) => item.name === catalogItemName,
  );
  if (!newCatalogItem) {
    const itemNames = catalogItems.data.map((i) => i.name).join(", ");
    throw new Error(
      `Failed to find catalog item "${catalogItemName}". Available items: [${itemNames}]`,
    );
  }
  return { id: newCatalogItem.id, name: newCatalogItem.name };
}

export async function findCatalogItem(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const response = await request.get(
    `${API_BASE_URL}/api/internal_mcp_catalog`,
    {
      headers: { Origin: UI_BASE_URL },
    },
  );

  if (!response.ok()) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch internal MCP catalog: ${response.status()} ${errorText}`,
    );
  }

  const catalog = await response.json();

  if (!Array.isArray(catalog)) {
    throw new Error(
      `Expected catalog to be an array, got: ${JSON.stringify(catalog)}`,
    );
  }

  return catalog.find((item: { name: string }) => item.name === name);
}

export async function findInstalledServer(
  request: APIRequestContext,
  catalogId: string,
  teamId?: string,
): Promise<{ id: string; catalogId: string; teamId?: string } | undefined> {
  const response = await request.get(`${API_BASE_URL}/api/mcp_server`, {
    headers: { Origin: UI_BASE_URL },
  });
  const serversData = await response.json();
  const servers = serversData.data || serversData;
  return servers.find((server: { catalogId: string; teamId?: string }) => {
    if (server.catalogId !== catalogId) return false;
    if (teamId !== undefined && server.teamId !== teamId) return false;
    return true;
  });
}

export async function waitForServerInstallation(
  request: APIRequestContext,
  serverId: string,
  maxAttempts = 60,
): Promise<{
  localInstallationStatus: string;
  localInstallationError?: string;
}> {
  for (let index = 0; index < maxAttempts; index += 1) {
    const response = await request.get(
      `${API_BASE_URL}/api/mcp_server/${serverId}`,
      {
        headers: { Origin: UI_BASE_URL },
      },
    );
    const server = await response.json();

    if (server.localInstallationStatus === "success") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return server;
    }
    if (server.localInstallationStatus === "error") {
      throw new Error(
        `MCP server installation failed: ${server.localInstallationError}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `MCP server installation timed out after ${maxAttempts * 2} seconds`,
  );
}
