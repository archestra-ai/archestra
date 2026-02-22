import type { Page } from "@playwright/test";
import { E2eTestId } from "@shared";
import { expect, goToPage, test } from "../../fixtures";
import { clickButton, expandTablePagination } from "../../utils";

const TEST_API_KEY = "sk-ant-test-key-12345";

/**
 * Navigate to the Provider Settings page (API Keys tab) and expand pagination.
 */
async function goToApiKeysPage(page: Page) {
  await goToPage(page, "/llm-proxies/provider-settings");
  await expandTablePagination(page, E2eTestId.ChatApiKeysTable);
}

/**
 * Navigate to the Provider Settings page (Virtual API Keys tab).
 */
async function goToVirtualKeysPage(page: Page) {
  await goToPage(page, "/llm-proxies/provider-settings?tab=virtual-keys");
}

test.describe("Provider Settings - API Keys", () => {
  test.describe.configure({ mode: "serial" });

  test("Admin can create, update, and delete an API key", async ({
    page,
    makeRandomString,
  }) => {
    const keyName = makeRandomString(8, "Test Key");
    const updatedName = makeRandomString(8, "Updated Test Key");

    await goToApiKeysPage(page);

    // Create
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    await expect(
      page.getByRole("heading", { name: /Add API Key/i }),
    ).toBeVisible();
    await page.getByLabel(/Name/i).fill(keyName);
    await expect(
      page.getByRole("combobox", { name: "Provider" }),
    ).toContainText("Anthropic");
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);
    await clickButton({ page, options: { name: "Test & Create" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName}`),
    ).toBeVisible();

    // Update
    await page
      .getByTestId(`${E2eTestId.EditChatApiKeyButton}-${keyName}`)
      .click();
    await page.getByLabel(/Name/i).clear();
    await page.getByLabel(/Name/i).fill(updatedName);
    await clickButton({ page, options: { name: "Test & Save" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${updatedName}`),
    ).toBeVisible();

    // Delete
    await page
      .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${updatedName}`)
      .click();
    await clickButton({ page, options: { name: "Delete" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${updatedName}`),
    ).not.toBeVisible();
  });

  test("Can create multiple keys for the same provider and scope", async ({
    page,
    makeRandomString,
  }) => {
    const keyName1 = makeRandomString(8, "Multi Key A");
    const keyName2 = makeRandomString(8, "Multi Key B");

    await goToApiKeysPage(page);

    // Create first key
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    await page.getByLabel(/Name/i).fill(keyName1);
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);
    await clickButton({ page, options: { name: "Test & Create" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName1}`),
    ).toBeVisible();

    // Create second key for same provider+scope — should succeed
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    await page.getByLabel(/Name/i).fill(keyName2);
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);
    await clickButton({ page, options: { name: "Test & Create" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName2}`),
    ).toBeVisible();

    // Both keys visible
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName1}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName2}`),
    ).toBeVisible();

    // Cleanup
    for (const name of [keyName1, keyName2]) {
      await page
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${name}`)
        .click();
      await clickButton({ page, options: { name: "Delete" } });
    }
  });

  test("First key for a provider defaults to primary, subsequent does not", async ({
    page,
    makeRandomString,
  }) => {
    const keyName1 = makeRandomString(8, "Primary Key");
    const keyName2 = makeRandomString(8, "Secondary Key");

    await goToApiKeysPage(page);

    // Create first key — isPrimary should be ON by default
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    // Select a provider that is very unlikely to have existing keys
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "Zhipu AI Zhipu AI" }).click();
    await page.getByLabel(/Name/i).fill(keyName1);
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);

    // Primary key toggle should be checked
    const primarySwitch = page.getByRole("switch", { name: /Primary key/i });
    await expect(primarySwitch).toBeChecked();

    await clickButton({ page, options: { name: "Test & Create" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName1}`),
    ).toBeVisible();

    // Create second key for same provider — isPrimary should be OFF
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "Zhipu AI Zhipu AI" }).click();
    await page.getByLabel(/Name/i).fill(keyName2);
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);

    // Primary key toggle should be unchecked and disabled
    const primarySwitch2 = page.getByRole("switch", { name: /Primary key/i });
    await expect(primarySwitch2).not.toBeChecked();
    await expect(primarySwitch2).toBeDisabled();

    // Should show existing primary key message
    await expect(
      page.getByText(new RegExp(`"${keyName1}" is already the primary key`)),
    ).toBeVisible();

    // Cancel — don't create
    await clickButton({ page, options: { name: "Cancel" } });

    // Cleanup
    await page
      .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${keyName1}`)
      .click();
    await clickButton({ page, options: { name: "Delete" } });
  });
});

test.describe("Provider Settings - Virtual API Keys", () => {
  test.describe.configure({ mode: "serial" });

  let parentKeyName: string;

  test("Can create a virtual key from the Virtual API Keys tab", async ({
    page,
    makeRandomString,
  }) => {
    parentKeyName = makeRandomString(8, "VK Parent");
    const virtualKeyName = makeRandomString(8, "VK Test");

    // First create a parent API key
    await goToApiKeysPage(page);
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    await page.getByLabel(/Name/i).fill(parentKeyName);
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);
    await clickButton({ page, options: { name: "Test & Create" } });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${parentKeyName}`),
    ).toBeVisible();

    // Navigate to Virtual API Keys tab
    await goToVirtualKeysPage(page);
    await expect(
      page.getByRole("heading", { name: "Virtual API Keys" }),
    ).toBeVisible();

    // Click Create Virtual Key (waits for button to be enabled, i.e. parentable keys loaded)
    await clickButton({ page, options: { name: "Create Virtual Key" } });
    await expect(
      page.getByRole("heading", { name: /Create Virtual API Key/i }),
    ).toBeVisible();

    // Select the correct parent key from the dropdown
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: new RegExp(parentKeyName) }).click();

    // Fill name and create
    await page.getByLabel(/Name/i).fill(virtualKeyName);
    await clickButton({ page, options: { name: "Create" } });

    // Should show the created key value (dialog title, not the toast)
    await expect(
      page.getByRole("heading", { name: "Virtual API Key Created" }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // The token value should be visible inside the dialog (starts with archestra_)
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.locator("code").filter({ hasText: "archestra_" }).last(),
    ).toBeVisible();

    // Close dialog (use first: true to avoid strict mode violation — the dialog
    // has two Close buttons: the footer button and the X icon)
    await clickButton({ page, options: { name: "Close" }, first: true });

    // Virtual key should appear in the table
    await expect(page.getByText(virtualKeyName)).toBeVisible();
  });

  test("Can delete a virtual key", async ({ page }) => {
    await goToVirtualKeysPage(page);

    // Find a delete button in the virtual keys table and click it
    const deleteButton = page.getByRole("button", { name: /delete/i }).first();
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
      // Confirm deletion in the confirmation dialog
      await clickButton({ page, options: { name: "Delete" } });
      // Wait for deletion to take effect
      await page.waitForLoadState("domcontentloaded");
    }

    // Cleanup: delete the parent API key
    if (parentKeyName) {
      await goToApiKeysPage(page);
      await page
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${parentKeyName}`)
        .click();
      await clickButton({ page, options: { name: "Delete" } });
    }
  });
});

test.describe("Provider Settings - Tab Navigation", () => {
  test("All three tabs are accessible", async ({ page }) => {
    // API Keys tab (default)
    await goToPage(page, "/llm-proxies/provider-settings");
    await expect(page.getByText("LLM API Keys")).toBeVisible();

    // Virtual API Keys tab
    await page.getByRole("link", { name: "Virtual API Keys" }).click();
    await page.waitForURL("**/provider-settings?tab=virtual-keys");
    await expect(
      page.getByRole("heading", { name: "Virtual API Keys" }),
    ).toBeVisible();

    // Models tab
    await page.getByRole("link", { name: "Models" }).click();
    await page.waitForURL("**/provider-settings?tab=models");
    await expect(
      page.getByRole("heading", { name: "Available Models" }),
    ).toBeVisible();
  });
});
