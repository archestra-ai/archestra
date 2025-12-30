import {
  archestraApiSdk,
  DEFAULT_VAULT_TOKEN,
  E2eTestId,
  SecretsManagerType,
} from "@shared";
import { DEFAULT_TEAM_NAME } from "../../consts";
import { expect, goToPage, test } from "../../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  clickButton,
  goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect,
  verifyToolCallResultViaApi,
} from "../../utils";

const vaultAddr = "http://localhost:8200";
const teamFolderPath = "secret/data/teams";
const secretName = "default-team";
const secretKey = "api_key";
const secretValue = "Admin-personal-credential";

test.describe.configure({ mode: "serial" });

test("At the beginning of tests, we change secrets manager to BYOS_VAULT", async ({
  adminPage,
  extractCookieHeaders,
}) => {
  await goToPage(adminPage, "/mcp-catalog/registry");
  await adminPage.waitForLoadState("networkidle");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  const { data } = await archestraApiSdk.initializeSecretsManager({
    body: {
      type: SecretsManagerType.BYOS_VAULT,
    },
    headers: { Cookie: cookieHeaders },
  });
  expect(data?.type).toBe(SecretsManagerType.BYOS_VAULT);
});

test("Then we create folder in Vault for Default Team and exemplary secret", async () => {
  // Define the path for Default Team secrets
  // Using the format: secret/data/teams/default-team
  const fullSecretPath = `${teamFolderPath}/${secretName}`;

  // Create an exemplary secret in Vault using KV v2 format
  const secretData = {
    data: {
      [secretKey]: secretValue,
      description: "Example API credentials for Default Team",
    },
  };

  // Write secret to Vault using HTTP API
  const response = await fetch(`${vaultAddr}/v1/${fullSecretPath}`, {
    method: "POST",
    headers: {
      "X-Vault-Token": DEFAULT_VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(secretData),
  });

  expect(response.ok).toBeTruthy();

  // Verify the secret was created by reading it back
  const readResponse = await fetch(`${vaultAddr}/v1/${fullSecretPath}`, {
    method: "GET",
    headers: {
      "X-Vault-Token": DEFAULT_VAULT_TOKEN,
    },
  });

  expect(readResponse.ok).toBeTruthy();
  const readData = await readResponse.json();

  // Verify the secret data matches what we wrote
  expect(readData.data.data[secretKey]).toBe(secretValue);
});

test("Then we configure vault for Default Team", async ({ adminPage }) => {
  await goToPage(adminPage, "/settings/teams");
  await adminPage
    .getByTestId(`${E2eTestId.ConfigureVaultFolderButton}-${DEFAULT_TEAM_NAME}`)
    .click();
  await adminPage
    .getByRole("textbox", { name: "Vault Path" })
    .fill(teamFolderPath);

  // test connection
  await clickButton({ page: adminPage, options: { name: "Test Connection" } });
  await expect(adminPage.getByText("Connection Successful")).toBeVisible();

  const saveAvailable = await adminPage
    .getByRole("button", { name: "Save Path" })
    .isVisible();

  // save if not already configured
  if (saveAvailable) {
    await clickButton({ page: adminPage, options: { name: "Save Path" } });
  }
});

test.describe("Chat API Keys with Readonly Vault", () => {
  ["team", "personal"].forEach((scope) => {
    test(`should create a ${scope} scoped chat API key with vault secret`, async ({
      adminPage,
      makeRandomString,
    }) => {
      const keyName = makeRandomString(8, "Test Key");

      // Open Create personal chat API key form and fill in the form
      await goToPage(adminPage, "/settings/chat");
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
        await adminPage.getByText(secretName).click();
        await adminPage.waitForLoadState("networkidle");
        await adminPage
          .getByTestId(E2eTestId.ExternalSecretSelectorSecretTriggerKey)
          .click();
        await adminPage.getByText(secretKey).click();
      } else {
        await adminPage.getByRole("combobox", { name: "Scope" }).click();
        await adminPage.getByRole("option", { name: "Team" }).click();
        await adminPage.getByRole("combobox", { name: "Team" }).click();
        await adminPage.waitForLoadState("networkidle");
        await adminPage
          .getByRole("option", { name: DEFAULT_TEAM_NAME })
          .click();
        await adminPage
          .getByTestId(E2eTestId.InlineVaultSecretSelectorSecretTrigger)
          .click();
        await adminPage.getByText(secretName).click();
        await adminPage.waitForLoadState("networkidle");
        await adminPage
          .getByTestId(E2eTestId.InlineVaultSecretSelectorSecretTriggerKey)
          .click();
        await adminPage.getByText(secretKey).click();
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
      await goToPage(adminPage, "/settings/chat");
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

    // Go to MCP Registry page
    await goToPage(adminPage, "/mcp-catalog/registry");
    await adminPage.waitForLoadState("networkidle");

    // Click connect button for the catalog item
    await adminPage
      .getByTestId(
        `${E2eTestId.ConnectCatalogItemButton}-${newCatalogItem.name}`,
      )
      .click();
    await adminPage.waitForTimeout(2_000);

    // Select secret from vault
    await adminPage
      .getByTestId(E2eTestId.InlineVaultSecretSelectorSecretTrigger)
      .click();
    await adminPage.getByText(secretName).click();
    await adminPage.waitForLoadState("networkidle");
    await adminPage
      .getByTestId(E2eTestId.InlineVaultSecretSelectorSecretTriggerKey)
      .click();
    await adminPage.getByText(secretKey).click();

    // install server
    await clickButton({ page: adminPage, options: { name: "Install" } });

    await adminPage.waitForLoadState("networkidle");

    // Assign tool to profiles using admin static credential
    await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
      page: adminPage,
      catalogItemName: newCatalogItem.name,
    });

    // Select default team credential
    await adminPage.getByRole("option", { name: DEFAULT_TEAM_NAME }).click();
    await adminPage.getByText("Assign to 1 profile").click();
    await adminPage.waitForLoadState("networkidle");

    // Verify tool call result using admin static credential
    await verifyToolCallResultViaApi({
      request: adminPage.request,
      expectedResult: secretValue,
      tokenToUse: "org-token",
      toolName: `${newCatalogItem.name}__print_archestra_test`,
      cookieHeaders,
    });

    // CLEANUP: Delete the catalog item
    await archestraApiSdk.deleteInternalMcpCatalogItem({
      path: { id: newCatalogItem.id },
      headers: { Cookie: cookieHeaders },
    });

    // CLEANUP: Delete the folder in Vault
    await fetch(`${vaultAddr}/v1/${teamFolderPath}`, {
      method: "DELETE",
      headers: {
        "X-Vault-Token": DEFAULT_VAULT_TOKEN,
      },
    });
  });

  test("Test self-hosted MCP server with Vault - without prompt on installation", async ({
    adminPage,
    extractCookieHeaders,
    makeRandomString,
  }) => {
    const cookieHeaders = await extractCookieHeaders(adminPage);
    const catalogItemName = makeRandomString(10, "mcp");

    const newCatalogItem = await addCustomSelfHostedCatalogItem({
      page: adminPage,
      cookieHeaders,
      catalogItemName,
      envVars: {
        key: "ARCHESTRA_TEST",
        promptOnInstallation: false,
        isSecret: true,
        vaultSecret: {
          teamName: DEFAULT_TEAM_NAME,
          name: secretName,
          key: secretKey,
          value: secretValue,
        },
      },
    });

    // Go to MCP Registry page
    await goToPage(adminPage, "/mcp-catalog/registry");
    await adminPage.waitForLoadState("networkidle");

    // Click connect button for the catalog item
    await adminPage
      .getByTestId(
        `${E2eTestId.ConnectCatalogItemButton}-${newCatalogItem.name}`,
      )
      .click();

    // install server
    await clickButton({ page: adminPage, options: { name: "Install" } });
    await adminPage.waitForLoadState("networkidle");

    // Assign tool to profiles using admin static credential
    await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
      page: adminPage,
      catalogItemName: newCatalogItem.name,
    });

    // Select default team credential
    await adminPage.getByRole("option", { name: DEFAULT_TEAM_NAME }).click();
    await adminPage.getByText("Assign to 1 profile").click();
    await adminPage.waitForLoadState("networkidle");

    // Verify tool call result using admin static credential
    await verifyToolCallResultViaApi({
      request: adminPage.request,
      expectedResult: secretValue,
      tokenToUse: "org-token",
      toolName: `${newCatalogItem.name}__print_archestra_test`,
      cookieHeaders,
    });

    // CLEANUP: Delete the catalog item
    await archestraApiSdk.deleteInternalMcpCatalogItem({
      path: { id: newCatalogItem.id },
      headers: { Cookie: cookieHeaders },
    });

    // CLEANUP: Delete the folder in Vault
    await fetch(`${vaultAddr}/v1/${teamFolderPath}`, {
      method: "DELETE",
      headers: {
        "X-Vault-Token": DEFAULT_VAULT_TOKEN,
      },
    });
  });
});

test("At the end of tests, we change secrets manager to DB because all other tests rely on it", async ({
  adminPage,
  extractCookieHeaders,
}) => {
  const cookieHeaders = await extractCookieHeaders(adminPage);
  const { data } = await archestraApiSdk.initializeSecretsManager({
    body: {
      type: SecretsManagerType.DB,
    },
    headers: { Cookie: cookieHeaders },
  });
  expect(data?.type).toBe(SecretsManagerType.DB);
});
