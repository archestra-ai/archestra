import { E2eTestId, getVirtualKeyRowTestId } from "@archestra/shared";
import { expect, test } from "../fixtures";
import {
  clickButton,
  createLlmProviderApiKey,
  createVirtualKey,
  deleteVisibleProviderKeys,
  goToLlmProviderApiKeysPage,
  goToVirtualKeysPage,
} from "../utils";

const TEST_API_KEY = "sk-ant-test-key-12345";
const TEST_PROVIDER = "zhipuai";
const TEST_PROVIDER_OPTION_NAME = "Zhipu AI Zhipu AI";

// Serial mode keeps `--repeat-each` reps sequential. Without it, parallel
// reps race on the shared Zhipu provider state (one rep's
// `deleteVisibleProviderKeys` cleans up another rep's just-created key).
test.describe.configure({ mode: "serial" });

test.describe("Provider Settings - Virtual API Keys", () => {
  test("Can create a virtual key from the Virtual API Keys tab", async ({
    page,
    makeRandomString,
    request,
  }) => {
    const parentKeyName = makeRandomString(8, "VK Parent");
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

    try {
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
    } finally {
      // API teardown — UI delete returns when the row leaves the DOM
      // (TanStack Query invalidate/refetch), but the DELETE round-trip can
      // lag, leaving the VK→parent mapping intact and breaking the next
      // run's startup cleanup with a 400 "mapped to virtual API keys".
      await deleteVisibleProviderKeys(request, TEST_PROVIDER);
    }
  });
});
