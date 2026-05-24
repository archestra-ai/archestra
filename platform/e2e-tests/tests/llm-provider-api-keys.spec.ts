import { E2eTestId } from "@shared";
import { expect, test } from "../fixtures";
import {
  clickButton,
  createLlmProviderApiKey,
  goToLlmProviderApiKeysPage,
} from "../utils";

const TEST_API_KEY = "sk-ant-test-key-12345";

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
});
