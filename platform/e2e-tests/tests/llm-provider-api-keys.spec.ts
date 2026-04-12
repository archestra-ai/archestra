import { E2eTestId } from "@shared";
import { expect, test } from "../fixtures";
import {
  clickButton,
  createLlmProviderApiKey,
  deleteLlmProviderApiKey,
  deleteVisibleProviderKeys,
  goToLlmProviderApiKeysPage,
} from "../utils";

const TEST_API_KEY = "sk-ant-test-key-12345";
const TEST_PROVIDER = "zhipuai";
const TEST_PROVIDER_OPTION_NAME = "Zhipu AI Zhipu AI";

test.describe.configure({ mode: "serial" });

test.describe("LLM Provider API Keys", () => {
  test.describe.configure({ mode: "serial" });

  test("Admin can create, update, and delete an API key", async ({
    page,
    makeRandomString,
  }) => {
    const keyName = makeRandomString(8, "Test Key");
    const updatedName = makeRandomString(8, "Updated Test Key");

    await goToLlmProviderApiKeysPage(page);

    // Create
    await createLlmProviderApiKey(page, {
      name: keyName,
      apiKey: TEST_API_KEY,
    });

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

    await goToLlmProviderApiKeysPage(page);

    // Create first key
    await createLlmProviderApiKey(page, {
      name: keyName1,
      apiKey: TEST_API_KEY,
    });

    // Create second key for same provider+scope — should succeed
    await createLlmProviderApiKey(page, {
      name: keyName2,
      apiKey: TEST_API_KEY,
    });

    // Both keys visible
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName1}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName2}`),
    ).toBeVisible();

    // Cleanup
    for (const name of [keyName1, keyName2]) {
      await deleteLlmProviderApiKey(page, name);
    }
  });

  test("First key for a provider defaults to primary, subsequent does not", async ({
    page,
    makeRandomString,
    request,
  }) => {
    const keyName1 = makeRandomString(8, "Primary Key");
    const keyName2 = makeRandomString(8, "Secondary Key");

    await deleteVisibleProviderKeys(request, TEST_PROVIDER);
    await goToLlmProviderApiKeysPage(page);

    // Create first key — isPrimary should be ON by default
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: TEST_PROVIDER_OPTION_NAME }).click();
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
    await page.getByRole("option", { name: TEST_PROVIDER_OPTION_NAME }).click();
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
    await deleteLlmProviderApiKey(page, keyName1);
  });
});
