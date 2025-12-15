import { archestraApiSdk, E2eTestId, SecretsManagerType } from "@shared";
import { expect, goToPage, test } from "../../fixtures";
import { addCustomSelfHostedCatalogItem } from "../../utils";

const vaultAddr = "http://localhost:8200";
const vaultToken = "dev-root-token";
const teamFolderPath = "secret/data/teams/default-team";

test.describe("Credentials with Vault", () => {
  test.describe.configure({ mode: "serial" });

  test("At the beginning of tests, we change secrets manager to BYOS_VAULT", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    const cookieHeaders = await extractCookieHeaders(adminPage);
    const { data } = await archestraApiSdk.initializeSecretsManager({
      body: {
        type: SecretsManagerType.BYOS_VAULT,
      },
      headers: { Cookie: cookieHeaders },
    });
    expect(data?.type).toBe(SecretsManagerType.BYOS_VAULT);
  });

  test("Create folder in Vault for Default Team and exemplary secret", async () => {
    // Define the path for Default Team secrets
    // Using the format: secret/data/teams/default-team
    const secretName = "example-api-key";
    const fullSecretPath = `${teamFolderPath}/${secretName}`;

    // Create an exemplary secret in Vault using KV v2 format
    const secretData = {
      data: {
        api_key: "sk-test-1234567890abcdef",
        api_secret: "secret-abcdef1234567890",
        description: "Example API credentials for Default Team",
      },
    };

    // Write secret to Vault using HTTP API
    const response = await fetch(`${vaultAddr}/v1/${fullSecretPath}`, {
      method: "POST",
      headers: {
        "X-Vault-Token": vaultToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(secretData),
    });

    expect(response.ok).toBeTruthy();

    // Verify the secret was created by reading it back
    const readResponse = await fetch(`${vaultAddr}/v1/${fullSecretPath}`, {
      method: "GET",
      headers: {
        "X-Vault-Token": vaultToken,
      },
    });

    expect(readResponse.ok).toBeTruthy();
    const readData = await readResponse.json();

    // Verify the secret data matches what we wrote
    expect(readData.data.data.api_key).toBe("sk-test-1234567890abcdef");
    expect(readData.data.data.api_secret).toBe("secret-abcdef1234567890");
    expect(readData.data.data.description).toBe(
      "Example API credentials for Default Team",
    );
  });

  test("Test self-hosted MCP server with Vault - with prompt on installation", async ({
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

    // Check that secrets are loading from Vault
    await expect(adminPage.getByText("Loading secrets...")).toBeVisible();

    // CLEANUP: Delete the catalog item
    await archestraApiSdk.deleteInternalMcpCatalogItem({
      path: { id: newCatalogItem.id },
      headers: { Cookie: cookieHeaders },
    });

    // CLEANUP: Delete the folder in Vault
    await fetch(`${vaultAddr}/v1/${teamFolderPath}`, {
      method: "DELETE",
      headers: {
        "X-Vault-Token": vaultToken,
      },
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
});
