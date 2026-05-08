import { E2eTestId, getVirtualKeyRowTestId } from "@shared";
import { expect, test } from "../fixtures";
import {
  clickButton,
  createLlmProviderApiKey,
  createVirtualKey,
  deleteLlmProviderApiKey,
  deleteVisibleProviderKeys,
  goToLlmProviderApiKeysPage,
  goToVirtualKeysPage,
} from "../utils";

const TEST_API_KEY = "sk-ant-test-key-12345";
const TEST_PROVIDER = "zhipuai";
const TEST_PROVIDER_OPTION_NAME = "Zhipu AI Zhipu AI";

test.describe.configure({ mode: "serial" });

test.describe("Provider Settings - Virtual API Keys", () => {
  test.describe.configure({ mode: "serial" });

  let parentKeyName: string;

  test("Can create a virtual key from the Virtual API Keys tab", async ({
    page,
    makeRandomString,
    request,
  }) => {
    parentKeyName = makeRandomString(8, "VK Parent");
    const virtualKeyName = makeRandomString(8, "VK Test");

    await deleteVisibleProviderKeys(request, TEST_PROVIDER);
    await goToLlmProviderApiKeysPage(page);
    await createLlmProviderApiKey(page, {
      name: parentKeyName,
      apiKey: TEST_API_KEY,
      providerOptionName: TEST_PROVIDER_OPTION_NAME,
    });

    await goToVirtualKeysPage(page);

    await createVirtualKey(page, {
      name: virtualKeyName,
      parentKeyOptionName: new RegExp(parentKeyName),
      parentProvider: "Zhipu",
    });

    await expect(
      page
        .getByTestId(E2eTestId.VirtualKeyValue)
        .locator("code")
        .filter({ hasText: /^(arch_|archestra_)/ })
        .last(),
    ).toBeVisible();

    await clickButton({ page, options: { name: "Close" }, first: true });

    await expect(
      page.getByTestId(getVirtualKeyRowTestId(virtualKeyName)),
    ).toBeVisible();
  });

  test("Can delete a virtual key", async ({ page }) => {
    await goToVirtualKeysPage(page);

    const deleteButton = page.getByRole("button", { name: /delete/i }).first();
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
      await clickButton({ page, options: { name: "Delete" } });
      await page.waitForLoadState("domcontentloaded");
    }

    if (parentKeyName) {
      await goToLlmProviderApiKeysPage(page);
      await deleteLlmProviderApiKey(page, parentKeyName);
    }
  });
});

test.describe("Provider Settings - Virtual Keys for Keyless Provider", () => {
  test.describe.configure({ mode: "serial" });

  test("Can create a virtual key for a keyless (no API key) provider", async ({
    page,
    makeRandomString,
  }) => {
    const virtualKeyName = makeRandomString(8, "Keyless VK");

    await goToVirtualKeysPage(page);

    await createVirtualKey(page, {
      name: virtualKeyName,
      parentProvider: "gemini",
    });

    await expect(
      page
        .getByTestId(E2eTestId.VirtualKeyValue)
        .locator("code")
        .filter({ hasText: /^(arch_|archestra_)/ })
        .last(),
    ).toBeVisible();

    await clickButton({ page, options: { name: "Close" }, first: true });
    await expect(
      page.getByTestId(getVirtualKeyRowTestId(virtualKeyName)),
    ).toBeVisible();
  });

  test("Cleanup keyless parent key", async ({ page }) => {
    await goToVirtualKeysPage(page);

    const deleteButton = page.getByRole("button", { name: /delete/i }).first();
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
      await clickButton({ page, options: { name: "Delete" } });
      await page.waitForLoadState("domcontentloaded");
    }
  });
});
