import { E2eTestId, getVirtualKeyRowTestId } from "@shared";
import { expect, test } from "../../fixtures";
import { clickButton } from "../../utils";
import {
  createChatApiKey,
  createVirtualKey,
  deleteChatApiKey,
  goToChatApiKeysPage,
  goToVirtualKeysPage,
} from "../../utils/chat-settings";

const TEST_API_KEY = "sk-ant-test-key-12345";

test.describe.configure({ mode: "serial" });

test.describe("Provider Settings - API Keys", () => {
  test.describe.configure({ mode: "serial" });

  test("Admin can create, update, and delete an API key", async ({
    page,
    makeRandomString,
  }) => {
    const keyName = makeRandomString(8, "Test Key");
    const updatedName = makeRandomString(8, "Updated Test Key");

    await goToChatApiKeysPage(page);

    // Create
    await createChatApiKey(page, { name: keyName, apiKey: TEST_API_KEY });

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

    await goToChatApiKeysPage(page);

    // Create first key
    await createChatApiKey(page, { name: keyName1, apiKey: TEST_API_KEY });

    // Create second key for same provider+scope — should succeed
    await createChatApiKey(page, { name: keyName2, apiKey: TEST_API_KEY });

    // Both keys visible
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName1}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName2}`),
    ).toBeVisible();

    // Cleanup
    for (const name of [keyName1, keyName2]) {
      await deleteChatApiKey(page, name);
    }
  });

  test("First key for a provider defaults to primary, subsequent does not", async ({
    page,
    makeRandomString,
  }) => {
    const keyName1 = makeRandomString(8, "Primary Key");
    const keyName2 = makeRandomString(8, "Secondary Key");

    await goToChatApiKeysPage(page);

    // Create first key — isPrimary should be ON by default
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
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
    await deleteChatApiKey(page, keyName1);
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
    await goToChatApiKeysPage(page);
    await createChatApiKey(page, {
      name: parentKeyName,
      apiKey: TEST_API_KEY,
      providerOptionName: "Zhipu AI Zhipu AI",
    });

    // Navigate to Virtual API Keys tab
    await goToVirtualKeysPage(page);

    await createVirtualKey(page, {
      name: virtualKeyName,
      parentKeyOptionName: new RegExp(parentKeyName),
    });

    // The token value should be visible inside the dialog (starts with archestra_)
    await expect(
      page
        .getByTestId(E2eTestId.VirtualKeyValue)
        .locator("code")
        .filter({ hasText: "archestra_" })
        .last(),
    ).toBeVisible();

    // Close dialog (use first: true to avoid strict mode violation — the dialog
    // has two Close buttons: the footer button and the X icon)
    await clickButton({ page, options: { name: "Close" }, first: true });

    // Virtual key should appear in the table
    await expect(
      page.getByTestId(getVirtualKeyRowTestId(virtualKeyName)),
    ).toBeVisible();
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
      await goToChatApiKeysPage(page);
      await deleteChatApiKey(page, parentKeyName);
    }
  });
});

test.describe("Provider Settings - Virtual Keys for Keyless Provider", () => {
  test.describe.configure({ mode: "serial" });

  let _keylessParentName: string;

  test("Can create a virtual key for a keyless (no API key) provider", async ({
    page,
    makeRandomString,
  }) => {
    const virtualKeyName = makeRandomString(8, "Keyless VK");

    // Navigate to Virtual API Keys tab
    await goToVirtualKeysPage(page);

    _keylessParentName = "Vertex AI";
    await createVirtualKey(page, {
      name: virtualKeyName,
      parentProvider: "gemini",
    });

    await expect(
      page
        .getByTestId(E2eTestId.VirtualKeyValue)
        .locator("code")
        .filter({ hasText: "archestra_" })
        .last(),
    ).toBeVisible();

    await clickButton({ page, options: { name: "Close" }, first: true });
    await expect(
      page.getByTestId(getVirtualKeyRowTestId(virtualKeyName)),
    ).toBeVisible();
  });

  test("Cleanup keyless parent key", async ({ page }) => {
    await goToVirtualKeysPage(page);

    // Delete the virtual key
    const deleteButton = page.getByRole("button", { name: /delete/i }).first();
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
      await clickButton({ page, options: { name: "Delete" } });
      await page.waitForLoadState("domcontentloaded");
    }

    // No parent API key cleanup needed: this test uses the existing system keyless provider entry.
  });
});
