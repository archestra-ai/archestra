import type { Page } from "@playwright/test";
import {
  archestraApiSdk,
  DEFAULT_VAULT_TOKEN,
  E2eTestId,
  SecretsManagerType,
} from "@shared";
import { testMcpServerCommand } from "@shared/test-mcp-server";
import {
  ADMIN_EMAIL,
  DEFAULT_TEAM_NAME,
  VAULT_ADDR,
  VAULT_KV_VERSION,
  VAULT_TEAM_FOLDER_PATH,
} from "../consts";
import { expect, goToPage, test } from "../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  assignCatalogCredentialToGateway,
  clickButton,
  createSharedTestGatewayViaApi,
  expandTablePagination,
  goToMcpRegistry,
  installMcpServer,
  settleRegistryAfterInstall,
  verifyToolCallResultViaApi,
  waitForInstallDialog,
  waitForMcpServerToolsDiscovered,
} from "../utils";

/**
 * Navigate to the LLM API Keys page and expand pagination to show all rows.
 */
async function goToApiKeysPage(page: Page) {
  await goToPage(page, "/llm/providers/api-keys");
  await expandTablePagination(page, E2eTestId.ChatApiKeysTable);
}

const secretName = "default-team";
const secretKey = "api_key";
const secretValue = "Admin-personal-credential";
let byosEnabled = true;

test.describe.configure({ mode: "serial" });

// Check if BYOS Vault is enabled via the features API.
// In CI, the Vault job deploys with ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT so all
// replicas start in BYOS mode. Locally, this may not be configured, so tests skip gracefully.
test("Check if BYOS Vault is enabled", async ({
  adminPage,
  extractCookieHeaders,
}) => {
  await goToPage(adminPage, "/mcp/registry");
  await adminPage.waitForLoadState("domcontentloaded");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  const { data: config } = await archestraApiSdk.getConfig({
    headers: { Cookie: cookieHeaders },
  });
  const secretsTypeResponse = await archestraApiSdk.getSecretsType({
    headers: { Cookie: cookieHeaders },
  });
  byosEnabled =
    !!config?.features?.byosEnabled &&
    secretsTypeResponse.data?.type === SecretsManagerType.BYOS_VAULT;
});

test("Then we create folder in Vault for Default Team and exemplary secret", async () => {
  test.skip(!byosEnabled, "BYOS Vault is not enabled in this environment.");
  await ensureVaultSecretExists();
});

// TODO: Fix flaky test
test.skip("Then we configure vault for Default Team", async ({ adminPage }) => {
  test.skip(!byosEnabled, "BYOS Vault is not enabled in this environment.");
  await goToPage(adminPage, "/settings/teams");
  // Wait for the configure button to appear - page may take time to render
  // team list and vault configuration UI in CI
  const configureButton = adminPage.getByTestId(
    `${E2eTestId.ConfigureVaultFolderButton}-${DEFAULT_TEAM_NAME}`,
  );
  await expect(configureButton).toBeVisible({ timeout: 30_000 });
  await configureButton.click();
  await adminPage
    .getByRole("textbox", { name: "Vault Path" })
    .fill(VAULT_TEAM_FOLDER_PATH);

  // test connection
  await clickButton({ page: adminPage, options: { name: "Test Connection" } });
  await expect(adminPage.getByText("Connection Successful")).toBeVisible();

  const savePathButton = adminPage.getByRole("button", { name: "Save Path" });
  const updatePathButton = adminPage.getByRole("button", {
    name: "Update Path",
  });

  if (await savePathButton.isVisible()) {
    await clickButton({ page: adminPage, options: { name: "Save Path" } });
  } else if (await updatePathButton.isVisible()) {
    await clickButton({ page: adminPage, options: { name: "Update Path" } });
  }
});

test.describe("Chat API Keys with Readonly Vault", () => {
  // TODO: Fix flaky Vault test - external service timing issues in CI
  test.skip();
  ["team", "personal"].forEach((scope) => {
    test(`should create a ${scope} scoped chat API key with vault secret`, async ({
      adminPage,
      makeRandomString,
    }) => {
      test.skip(!byosEnabled, "BYOS Vault is not enabled in this environment.");
      const keyName = makeRandomString(8, "Test Key");

      // Open Create personal chat API key form and fill in the form
      await goToApiKeysPage(adminPage);
      await adminPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await adminPage.getByRole("textbox", { name: "Name" }).fill(keyName);

      if (scope === "personal") {
        await adminPage
          .getByTestId("external-secret-selector-team-trigger")
          .click();
        await adminPage
          .getByRole("option", { name: DEFAULT_TEAM_NAME })
          .click();
        await adminPage
          .getByTestId(E2eTestId.ExternalSecretSelectorSecretTrigger)
          .click();
        await adminPage.getByRole("option", { name: secretName }).click();
        await adminPage.waitForLoadState("domcontentloaded");
        await adminPage
          .getByTestId(E2eTestId.ExternalSecretSelectorSecretTriggerKey)
          .click();
        await adminPage.getByRole("option", { name: secretKey }).click();
      } else {
        await adminPage.getByRole("combobox", { name: "Scope" }).click();
        await adminPage.getByRole("option", { name: "Team" }).click();
        await adminPage.getByRole("combobox", { name: "Team" }).click();
        await adminPage.waitForLoadState("domcontentloaded");
        await adminPage
          .getByRole("option", { name: DEFAULT_TEAM_NAME })
          .click();
        await adminPage
          .getByTestId(E2eTestId.InlineVaultSecretSelectorSecretTrigger)
          .click();
        await adminPage.getByRole("option", { name: secretName }).click();
        await adminPage.waitForLoadState("domcontentloaded");
        await adminPage
          .getByTestId(E2eTestId.InlineVaultSecretSelectorSecretTriggerKey)
          .click();
        await adminPage.getByRole("option", { name: secretKey }).click();
      }

      // Click create button
      await clickButton({
        page: adminPage,
        options: { name: "Test & Create" },
      });
      await expect(
        adminPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Verify API key is created
      await expect(
        adminPage.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName}`),
      ).toBeVisible();

      // Cleanup
      await goToApiKeysPage(adminPage);
      await adminPage
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${keyName}`)
        .click();
      await clickButton({ page: adminPage, options: { name: "Delete" } });
    });
  });
});

test.describe("Test self-hosted MCP server with Readonly Vault", () => {
  test("Test self-hosted MCP server with Vault - with prompt on installation", async ({
    adminPage,
    extractCookieHeaders,
    makeRandomString,
  }) => {
    test.skip(!byosEnabled, "BYOS Vault is not enabled in this environment.");
    test.setTimeout(90_000);
    const cookieHeaders = await extractCookieHeaders(adminPage);
    const catalogItemName = makeRandomString(10, "mcp");
    const newCatalogItem = await addCustomSelfHostedCatalogItem({
      page: adminPage,
      cookieHeaders,
      catalogItemName,
      envVars: {
        key: "ARCHESTRA_TEST",
        promptOnInstallation: true,
        isSecret: true,
      },
    });

    await ensureVaultSecretExists();
    await ensureDefaultTeamVaultFolder(cookieHeaders);

    const installResponse = await archestraApiSdk.installMcpServer({
      headers: { Cookie: cookieHeaders },
      body: {
        name: newCatalogItem.name,
        catalogId: newCatalogItem.id,
        environmentValues: {
          ARCHESTRA_TEST: `${VAULT_TEAM_FOLDER_PATH}/${secretName}#${secretKey}`,
        },
        isByosVault: true,
      },
    });

    if (installResponse.error) {
      throw new Error(
        `Failed to install prompt-on-install Vault MCP server: ${JSON.stringify(installResponse.error)}`,
      );
    }

    await goToMcpRegistry(adminPage);
    await waitForMcpServerToolsDiscovered(adminPage, newCatalogItem.name);
    await settleRegistryAfterInstall(adminPage);

    // Provision a shared org-scope gateway with default + engineering teams,
    // so that org-token tool calls can route through it after credential assignment.
    const sharedGateway = await createSharedTestGatewayViaApi({
      cookieHeaders,
      gatewayName: makeRandomString(10, "shared-gw"),
    });

    // The current prompt-on-install flow creates a personal connection.
    await assignCatalogCredentialToGateway({
      page: adminPage,
      catalogItemName: newCatalogItem.name,
      credentialName: ADMIN_EMAIL,
      gatewayName: sharedGateway.name,
    });

    // Verify tool call result using default team credential
    await verifyToolCallResultViaApi({
      request: adminPage.request,
      expectedResult: secretValue,
      tokenToUse: "org-token",
      toolName: `${newCatalogItem.name}__print_archestra_test`,
      profileId: sharedGateway.id,
    });

    // CLEANUP: Delete the catalog item
    await archestraApiSdk.deleteInternalMcpCatalogItem({
      path: { id: newCatalogItem.id },
      headers: { Cookie: cookieHeaders },
    });
    await archestraApiSdk.deleteAgent({
      path: { id: sharedGateway.id },
      headers: { Cookie: cookieHeaders },
    });

    // Best-effort local cleanup. The Vault sidecar may already be gone by teardown.
    await fetch(`${VAULT_ADDR}/v1/${VAULT_TEAM_FOLDER_PATH}/${secretName}`, {
      method: "DELETE",
      headers: {
        "X-Vault-Token": DEFAULT_VAULT_TOKEN,
      },
    }).catch(() => undefined);
  });

  test("Test self-hosted MCP server with Vault - without prompt on installation", async ({
    adminPage,
    extractCookieHeaders,
    makeRandomString,
  }) => {
    test.skip(
      true,
      "Currently failing: readonly-vault tool assign returns 'team connection not shared with selected team'",
    );
    test.skip(!byosEnabled, "BYOS Vault is not enabled in this environment.");
    const cookieHeaders = await extractCookieHeaders(adminPage);
    const catalogItemName = makeRandomString(10, "mcp");

    await ensureVaultSecretExists();
    await ensureDefaultTeamVaultFolder(cookieHeaders);

    const createCatalogResponse =
      await archestraApiSdk.createInternalMcpCatalogItem({
        headers: { Cookie: cookieHeaders },
        body: {
          name: catalogItemName,
          serverType: "local",
          scope: "personal",
          localConfig: {
            command: "sh",
            arguments: ["-c", testMcpServerCommand.replace(/\n/g, " ")],
            environment: [
              {
                key: "ARCHESTRA_TEST",
                type: "secret",
                value: `${VAULT_TEAM_FOLDER_PATH}/${secretName}#${secretKey}`,
                promptOnInstallation: false,
              },
            ],
          },
        },
      });
    if (createCatalogResponse.error || !createCatalogResponse.data) {
      throw new Error(
        `Failed to create readonly-vault catalog item: ${JSON.stringify(createCatalogResponse.error)}`,
      );
    }

    const newCatalogItem = {
      id: createCatalogResponse.data.id,
      name: createCatalogResponse.data.name,
    };

    const teamsResponse = await archestraApiSdk.getTeams({
      headers: { Cookie: cookieHeaders },
    });
    const defaultTeamId = teamsResponse.data?.data.find(
      (team) => team.name === DEFAULT_TEAM_NAME,
    )?.id;
    if (!defaultTeamId) {
      throw new Error(`Team "${DEFAULT_TEAM_NAME}" not found`);
    }

    const installResponse = await archestraApiSdk.installMcpServer({
      headers: { Cookie: cookieHeaders },
      body: {
        name: newCatalogItem.name,
        catalogId: newCatalogItem.id,
        scope: "team",
        teamId: defaultTeamId,
      },
    });
    if (installResponse.error) {
      throw new Error(
        `Failed to install readonly-vault MCP server: ${JSON.stringify(installResponse.error)}`,
      );
    }

    await goToMcpRegistry(adminPage);
    await waitForMcpServerToolsDiscovered(adminPage, newCatalogItem.name);
    await settleRegistryAfterInstall(adminPage);

    const sharedGateway = await createSharedTestGatewayViaApi({
      cookieHeaders,
      gatewayName: makeRandomString(10, "shared-gw"),
    });

    const toolsResponse = await archestraApiSdk.getTools({
      headers: { Cookie: cookieHeaders },
    });
    const toolIds =
      toolsResponse.data
        ?.filter((tool) => tool.name.startsWith(`${newCatalogItem.name}__`))
        .map((tool) => tool.id) ?? [];
    if (toolIds.length === 0) {
      throw new Error(
        `No discovered tools found for readonly-vault catalog ${newCatalogItem.name}`,
      );
    }

    const serversResponse = await archestraApiSdk.getMcpServers({
      headers: { Cookie: cookieHeaders },
      query: { catalogId: newCatalogItem.id },
    });
    const defaultTeamServer = serversResponse.data?.find(
      (server) => server.teamId === defaultTeamId,
    );
    if (!defaultTeamServer) {
      throw new Error(
        `No team installation found for readonly-vault catalog ${newCatalogItem.name}`,
      );
    }

    for (const toolId of toolIds) {
      const assignResponse = await archestraApiSdk.assignToolToAgent({
        headers: { Cookie: cookieHeaders },
        path: {
          agentId: sharedGateway.id,
          toolId,
        },
        body: { mcpServerId: defaultTeamServer.id },
      });
      if (assignResponse.error) {
        throw new Error(
          `Failed to assign readonly-vault tool ${toolId}: ${JSON.stringify(assignResponse.error)}`,
        );
      }
    }

    // Verify tool call result using default team credential
    await verifyToolCallResultViaApi({
      request: adminPage.request,
      expectedResult: secretValue,
      tokenToUse: "org-token",
      toolName: `${newCatalogItem.name}__print_archestra_test`,
      profileId: sharedGateway.id,
    });

    // CLEANUP: Delete the catalog item
    await archestraApiSdk.deleteInternalMcpCatalogItem({
      path: { id: newCatalogItem.id },
      headers: { Cookie: cookieHeaders },
    });

    // CLEANUP: Delete the folder in Vault
    await fetch(`${VAULT_ADDR}/v1/${VAULT_TEAM_FOLDER_PATH}`, {
      method: "DELETE",
      headers: {
        "X-Vault-Token": DEFAULT_VAULT_TOKEN,
      },
    });
  });

  test("Install dialog does not show vault folder selector when no prompt-on-install secret exists", async ({
    adminPage,
    extractCookieHeaders,
    makeRandomString,
  }) => {
    test.skip(!byosEnabled, "BYOS Vault is not enabled in this environment.");
    test.setTimeout(90_000);

    const cookieHeaders = await extractCookieHeaders(adminPage);
    const catalogItemName = makeRandomString(10, "mcp");

    await ensureVaultSecretExists();
    await ensureDefaultTeamVaultFolder(cookieHeaders);

    const newCatalogItem = await addCustomSelfHostedCatalogItem({
      page: adminPage,
      cookieHeaders,
      catalogItemName,
      envVars: {
        key: "ARCHESTRA_TEST",
        promptOnInstallation: false,
        isSecret: true,
        vaultSecret: {
          name: secretName,
          key: secretKey,
          value: secretValue,
          teamName: DEFAULT_TEAM_NAME,
        },
      },
    });

    await waitForInstallDialog(adminPage, { titlePattern: /Install -/ });

    await expect(
      adminPage.getByRole("dialog").getByText("Pull Vault secrets from:"),
    ).not.toBeVisible();
    await expect(
      adminPage.getByRole("dialog").getByText("-- Select Vault folder --"),
    ).not.toBeVisible();

    await installMcpServer(adminPage);

    await goToMcpRegistry(adminPage);
    await waitForMcpServerToolsDiscovered(adminPage, newCatalogItem.name);
    await settleRegistryAfterInstall(adminPage);

    await archestraApiSdk.deleteInternalMcpCatalogItem({
      path: { id: newCatalogItem.id },
      headers: { Cookie: cookieHeaders },
    });
  });
});

async function ensureDefaultTeamVaultFolder(cookieHeaders: string) {
  const teamsResponse = await archestraApiSdk.getTeams({
    headers: { Cookie: cookieHeaders },
  });
  const defaultTeamId = teamsResponse.data?.data.find(
    (team) => team.name === DEFAULT_TEAM_NAME,
  )?.id;

  if (!defaultTeamId) {
    throw new Error(`Could not find team "${DEFAULT_TEAM_NAME}"`);
  }

  const upsertResponse = await archestraApiSdk.setTeamVaultFolder({
    path: { teamId: defaultTeamId },
    headers: { Cookie: cookieHeaders },
    body: { vaultPath: VAULT_TEAM_FOLDER_PATH },
  });

  if (upsertResponse.error) {
    throw new Error(
      `Failed to configure default team vault folder: ${JSON.stringify(upsertResponse.error)}`,
    );
  }
}

async function ensureVaultSecretExists() {
  const fullSecretPath = `${VAULT_TEAM_FOLDER_PATH}/${secretName}`;
  const secretData =
    VAULT_KV_VERSION === "1"
      ? {
          [secretKey]: secretValue,
          description: "Example API credentials for Default Team",
        }
      : {
          data: {
            [secretKey]: secretValue,
            description: "Example API credentials for Default Team",
          },
        };

  const response = await fetch(`${VAULT_ADDR}/v1/${fullSecretPath}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": DEFAULT_VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(secretData),
  });

  expect(response.ok).toBeTruthy();

  const readResponse = await fetch(`${VAULT_ADDR}/v1/${fullSecretPath}`, {
    method: "GET",
    headers: {
      "X-Vault-Token": DEFAULT_VAULT_TOKEN,
    },
  });

  expect(readResponse.ok).toBeTruthy();
  const readData = await readResponse.json();
  const persistedSecret =
    VAULT_KV_VERSION === "1"
      ? readData.data?.[secretKey]
      : readData.data?.data?.[secretKey];
  expect(persistedSecret).toBe(secretValue);
}
