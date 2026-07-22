import { archestraApiSdk } from "@archestra/shared";
import { testMcpServerCommand } from "@archestra/shared/test-mcp-server";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { E2eTestId, getE2eRequestUrl, UI_BASE_URL } from "../consts";
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

  // "Add MCP Server" navigates to the routed /mcp/registry/new wizard: pick a
  // source first, then fill the same catalog form the old dialog hosted.
  await expect(
    page.getByRole("heading", {
      name: /Add MCP Server to the Private Registry/i,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Start from scratch" }).click();

  // The create form renders inline on the page (no dialog wrapper), so
  // page-level locators are unambiguous here.
  const createForm = page;

  await createForm.getByRole("button", { name: "Self-hosted" }).click();
  await createForm
    .getByRole("textbox", { name: "Name *" })
    .fill(catalogItemName);
  await createForm.getByLabel("stdio").click();
  await createForm.getByRole("textbox", { name: "Command" }).fill("sh");
  const singleLineCommand = testMcpServerCommand.replace(/\n/g, " ");
  await createForm
    .getByRole("textbox", { name: "Arguments (one per line)" })
    .fill(`-c\n${singleLineCommand}`);
  if (envVars) {
    // Since #4696, env-var add/edit lives in its own <StandardDialog>
    // (`environment-variable-dialog.tsx`) opened by the "Add Variable"
    // button. All the env-var-specific inputs scope to that sub-dialog
    // now — not the parent "Add MCP Server" dialog.
    await createForm.getByRole("button", { name: "Add Variable" }).click();
    const envVarDialog = page.getByRole("dialog", {
      name: /Add environment variable/i,
    });
    await expect(envVarDialog).toBeVisible({ timeout: 15_000 });

    // The key input's accessible name is now "Key" (the Label) — the old
    // "API_KEY" was placeholder text on the same input.
    await envVarDialog.getByRole("textbox", { name: "Key" }).fill(envVars.key);

    if (envVars.isSecret) {
      await envVarDialog
        .getByTestId(E2eTestId.SelectEnvironmentVariableType)
        .click();
      await page.getByRole("option", { name: "Secret" }).click();
    }

    // Scope is now a 3-option dropdown (installation/preset/static),
    // defaulting to "installation". The PromptOnInstallationCheckbox
    // testid is reused on the dropdown trigger for backwards compat.
    //
    // Logic inversion vs. the old checkbox: the old default was "not
    // prompted" (checkbox unchecked) and the helper toggled IT ON for
    // prompted envs. The new default is "Prompt at installation", so we
    // only need to act when the caller wants something other than that
    // — i.e. when promptOnInstallation is false (we want Static) or
    // when a vault reference is being set (vault picker only appears
    // for static-scoped secret values).
    const wantsStaticScope =
      !envVars.promptOnInstallation || !!envVars.vaultSecret;
    if (wantsStaticScope) {
      await envVarDialog
        .getByTestId(E2eTestId.PromptOnInstallationCheckbox)
        .click();
      await page.getByRole("option", { name: "Static" }).click();
    }

    if (envVars.vaultSecret) {
      // Button text changed: "Set Secret" → "Set external secret".
      await envVarDialog
        .getByRole("button", { name: /Set external secret/i })
        .click();
      const externalSecretDialog = page.getByRole("dialog", {
        name: /Set external secret/i,
      });
      await expect(externalSecretDialog).toBeVisible({ timeout: 15_000 });
      await externalSecretDialog
        .getByTestId(E2eTestId.ExternalSecretSelectorTeamTrigger)
        .click();
      await page
        .getByRole("option", { name: envVars.vaultSecret.teamName })
        .click();
      await externalSecretDialog
        .getByTestId(E2eTestId.ExternalSecretSelectorSecretTrigger)
        .click();
      await page
        .getByRole("option", { name: envVars.vaultSecret.name })
        .click();
      await externalSecretDialog
        .getByTestId(E2eTestId.ExternalSecretSelectorSecretTriggerKey)
        .click();
      await page.getByRole("option", { name: envVars.vaultSecret.key }).click();
      await externalSecretDialog
        .getByRole("button", { name: "Confirm" })
        .click();
      await expect(externalSecretDialog).not.toBeVisible({ timeout: 15_000 });
    }

    // Confirm and close the env-var sub-dialog so the parent "Add MCP
    // Server" form re-takes focus before we click "Add Server".
    await envVarDialog.getByRole("button", { name: "Add variable" }).click();
    await expect(envVarDialog).not.toBeVisible({ timeout: 15_000 });
  }
  if (scope && scope !== "personal") {
    await createForm
      .getByRole("button", { name: /Only you can access this MCP server/i })
      .click();
    const scopeLabel = scope === "org" ? "Organization" : "Teams";
    await createForm
      .getByRole("button", { name: new RegExp(scopeLabel, "i") })
      .click();
  }
  await createForm.getByRole("button", { name: "Add Server" }).click();
  await page.waitForLoadState("domcontentloaded");

  let newCatalogItem: { id: string; name: string } | null = null;
  await expect
    .poll(
      async () => {
        const catalogItems = await archestraApiSdk.getInternalMcpCatalog({
          headers: { Cookie: cookieHeaders },
        });

        if (catalogItems.error) {
          throw new Error(
            `Failed to get catalog items: ${JSON.stringify(catalogItems.error)}`,
          );
        }
        if (!catalogItems.data || catalogItems.data.length === 0) {
          return false;
        }

        newCatalogItem =
          catalogItems.data.find((item) => item.name === catalogItemName) ??
          null;
        return newCatalogItem !== null;
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      },
    )
    .toBe(true);

  if (!newCatalogItem) {
    throw new Error(`Failed to find catalog item "${catalogItemName}"`);
  }

  const createdCatalogItem = newCatalogItem as { id: string; name: string };

  return {
    id: createdCatalogItem.id,
    name: createdCatalogItem.name,
  };
}

async function findCatalogItem(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const response = await request.get(
    getE2eRequestUrl("/api/internal_mcp_catalog"),
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

  const catalog = extractCatalogItems(await response.json());

  return catalog.find((item: { name: string }) => item.name === name);
}

export async function ensureInternalDevTestServerCatalogItem(
  request: APIRequestContext,
): Promise<{ id: string; name: string }> {
  const existing = await findCatalogItem(request, "internal-dev-test-server");
  if (existing) {
    return existing;
  }

  const response = await request.post(
    getE2eRequestUrl("/api/internal_mcp_catalog"),
    {
      headers: {
        "Content-Type": "application/json",
        Origin: UI_BASE_URL,
      },
      data: {
        name: "internal-dev-test-server",
        description:
          "Simple test MCP server for e2e tests. Has one tool that prints an env var.",
        serverType: "local",
        localConfig: {
          command: "sh",
          arguments: ["-c", testMcpServerCommand],
          transportType: "stdio",
          environment: [
            {
              key: "ARCHESTRA_TEST",
              type: "plain_text",
              promptOnInstallation: true,
              required: true,
              description: "Test value to print",
            },
          ],
        },
      },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to create internal-dev-test-server catalog item: ${response.status()} ${await response.text()}`,
    );
  }

  const created = await response.json();
  return { id: created.id, name: created.name };
}

/**
 * Fixture server for the app SDK `tools.call` unwrapping contract: its single
 * tool returns a JSON object serialized into a text content block (no
 * structuredContent), which the SDK must resolve as the parsed value.
 */
export async function ensureAppSdkJsonTestServerCatalogItem(
  request: APIRequestContext,
): Promise<{ id: string; name: string }> {
  const existing = await findCatalogItem(
    request,
    APP_SDK_JSON_CATALOG_ITEM_NAME,
  );
  if (existing) {
    return existing;
  }

  const response = await request.post(
    getE2eRequestUrl("/api/internal_mcp_catalog"),
    {
      headers: {
        "Content-Type": "application/json",
        Origin: UI_BASE_URL,
      },
      data: {
        name: APP_SDK_JSON_CATALOG_ITEM_NAME,
        description:
          "Test MCP server for e2e tests. Has one tool that returns a JSON task list serialized into a text content block.",
        serverType: "local",
        localConfig: {
          command: "sh",
          arguments: ["-c", appSdkJsonServerCommand],
          transportType: "stdio",
          environment: [],
        },
      },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to create ${APP_SDK_JSON_CATALOG_ITEM_NAME} catalog item: ${response.status()} ${await response.text()}`,
    );
  }

  const created = await response.json();
  return { id: created.id, name: created.name };
}

export const APP_SDK_JSON_SERVER_TOOL_NAME = "get_tasks";

const appSdkJsonFixtureTasks = [
  { id: 1, title: "triage inbox" },
  { id: 2, title: "review pull request" },
  { id: 3, title: "publish release" },
];

export const APP_SDK_JSON_SERVER_TASK_COUNT = appSdkJsonFixtureTasks.length;

const APP_SDK_JSON_CATALOG_ITEM_NAME = "e2e-app-sdk-json-server";

// Single-line script, same shape/escaping as `testMcpServerCommand` in
// @archestra/shared/test-mcp-server (arguments are newline-separated in the UI).
const appSdkJsonServerScript = `const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'); const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'); const server = new McpServer({ name: '${APP_SDK_JSON_CATALOG_ITEM_NAME}', version: '1.0.0' }); server.tool('${APP_SDK_JSON_SERVER_TOOL_NAME}', 'Returns the fixture task list as JSON serialized into a text content block', {}, async () => ({ content: [{ type: 'text', text: ${JSON.stringify(JSON.stringify({ tasks: appSdkJsonFixtureTasks }))} }] })); const transport = new StdioServerTransport(); server.connect(transport);`;

const appSdkJsonServerCommand = `npm install --silent @modelcontextprotocol/sdk && node -e '${appSdkJsonServerScript.replace(/'/g, "'\"'\"'")}'`;

function extractCatalogItems(
  data: unknown,
): Array<{ id: string; name: string }> {
  if (Array.isArray(data)) {
    return data as Array<{ id: string; name: string }>;
  }

  if (
    data &&
    typeof data === "object" &&
    "data" in data &&
    Array.isArray(data.data)
  ) {
    return data.data as Array<{ id: string; name: string }>;
  }

  throw new Error(
    `Expected catalog list response, got: ${JSON.stringify(data)}`,
  );
}

export async function findInstalledServer(
  request: APIRequestContext,
  catalogId: string,
  teamId?: string,
): Promise<{ id: string; catalogId: string; teamId?: string } | undefined> {
  const response = await request.get(getE2eRequestUrl("/api/mcp_server"), {
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
      getE2eRequestUrl(`/api/mcp_server/${serverId}`),
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
