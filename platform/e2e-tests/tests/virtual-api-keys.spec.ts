import {
  E2eTestId,
  getDeleteVirtualKeyButtonTestId,
  getVirtualKeyRowTestId,
} from "@shared";
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
  let virtualKeyName: string;

  test("Can create a virtual key from the Virtual API Keys tab", async ({
    page,
    makeRandomString,
    request,
  }) => {
    parentKeyName = makeRandomString(8, "VK Parent");
    virtualKeyName = makeRandomString(8, "VK Test");

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

    if (virtualKeyName) {
      const rowTestId = getVirtualKeyRowTestId(virtualKeyName);
      const deleteButton = page.getByTestId(
        getDeleteVirtualKeyButtonTestId(virtualKeyName),
      );
      await expect(deleteButton).toBeVisible({ timeout: 15_000 });
      await deleteButton.click();
      await clickButton({ page, options: { name: "Delete" } });
      // wait for the row to fully disappear so the parent key dialog
      // below does not see the virtual key as still blocking
      await expect(page.getByTestId(rowTestId)).toBeHidden({
        timeout: 15_000,
      });
    }

    if (parentKeyName) {
      await goToLlmProviderApiKeysPage(page);
      await deleteLlmProviderApiKey(page, parentKeyName);
    }
  });
});

test.describe("Provider Settings - Virtual Keys for Keyless Provider", () => {
  test.describe.configure({ mode: "serial" });

  let keylessVirtualKeyName: string;

  test("Can create a virtual key for a keyless (no API key) provider", async ({
    page,
    makeRandomString,
  }) => {
    keylessVirtualKeyName = makeRandomString(8, "Keyless VK");

    await goToVirtualKeysPage(page);

    await createVirtualKey(page, {
      name: keylessVirtualKeyName,
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
      page.getByTestId(getVirtualKeyRowTestId(keylessVirtualKeyName)),
    ).toBeVisible();
  });

  test("Cleanup keyless virtual key", async ({ page }) => {
    if (!keylessVirtualKeyName) return;

    await goToVirtualKeysPage(page);

    const rowTestId = getVirtualKeyRowTestId(keylessVirtualKeyName);
    const deleteButton = page.getByTestId(
      getDeleteVirtualKeyButtonTestId(keylessVirtualKeyName),
    );
    await expect(deleteButton).toBeVisible({ timeout: 15_000 });
    await deleteButton.click();
    await clickButton({ page, options: { name: "Delete" } });
    await expect(page.getByTestId(rowTestId)).toBeHidden({ timeout: 15_000 });
  });
});
