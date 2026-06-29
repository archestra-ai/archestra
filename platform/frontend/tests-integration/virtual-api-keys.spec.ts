import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import {
  makeCreatedVirtualKey,
  makeLlmProviderApiKey,
  makeVirtualKey,
  makeVirtualKeysList,
} from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

const PROVIDER = "anthropic" as const;
const PROVIDER_OPTION_NAME = /Anthropic/i;

test.describe.configure({ mode: "serial" });

test.describe("Virtual API Keys", () => {
  test("Can create a virtual key from a parent provider key", async ({
    page,
    virtualKeysPage,
    mswControl,
  }) => {
    const PARENT_NAME = "Parent Provider Key";
    const VK_NAME = "Virtual Key 1";
    const parent = makeLlmProviderApiKey({
      id: "parent-key",
      name: PARENT_NAME,
      provider: PROVIDER,
    });
    const created = makeCreatedVirtualKey({
      id: "vk-created",
      name: VK_NAME,
      providerApiKeys: [
        {
          provider: PROVIDER,
          providerApiKeyId: parent.id,
          providerApiKeyName: PARENT_NAME,
        },
      ],
    });
    const createdSummary = makeVirtualKey({
      id: created.id,
      name: VK_NAME,
      providerApiKeys: created.providerApiKeys,
    });

    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [parent],
    });
    // Start with empty list so the row only appears after create+refetch.
    await mswControl.use({
      method: "get",
      url: "/api/llm-virtual-keys",
      body: makeVirtualKeysList({ keys: [] }),
    });

    await virtualKeysPage.goto();
    await virtualKeysPage.addButton.click();

    await page.getByLabel("Name", { exact: true }).fill(VK_NAME);

    // Provider Keys mapper: pick provider, then matching key, then Add.
    await page.getByTestId(E2eTestId.VirtualKeyProviderSelect).click();
    await page.getByRole("option", { name: PROVIDER_OPTION_NAME }).click();
    await page.getByTestId(E2eTestId.VirtualKeyParentKeySelect).click();
    await page.getByRole("option", { name: new RegExp(PARENT_NAME) }).click();
    await page.getByRole("button", { name: "Add" }).click();

    // POST and post-create refetch.
    await mswControl.use({
      method: "post",
      url: "/api/llm-virtual-keys",
      body: created,
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-virtual-keys",
      body: makeVirtualKeysList({ keys: [createdSummary] }),
    });

    await page.getByRole("button", { name: "Create" }).click();

    // Post-create view: the dialog renders the token value once.
    await expect(virtualKeysPage.valueDisplay).toBeVisible();
    await expect(
      virtualKeysPage.valueDisplay.locator("code").first(),
    ).toContainText(/^(arch_|archestra_)/);

    // The dialog has both an inline "Close" button (form footer) and an X icon
    // with the same accessible name. Scope to the form footer.
    await page.locator("form").getByRole("button", { name: "Close" }).click();

    await expect(virtualKeysPage.rowFor(VK_NAME)).toBeVisible();
  });

  test("Can delete a virtual key", async ({
    page,
    virtualKeysPage,
    mswControl,
  }) => {
    const VK_NAME = "Virtual Key to Delete";
    const parent = makeLlmProviderApiKey({ id: "parent-key" });
    const existing = makeVirtualKey({
      id: "vk-to-delete",
      name: VK_NAME,
      providerApiKeys: [
        {
          provider: PROVIDER,
          providerApiKeyId: parent.id,
          providerApiKeyName: parent.name,
        },
      ],
    });

    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [parent],
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-virtual-keys",
      body: makeVirtualKeysList({ keys: [existing] }),
    });

    await virtualKeysPage.goto();
    await expect(virtualKeysPage.rowFor(VK_NAME)).toBeVisible();

    await mswControl.use({
      method: "delete",
      url: "/api/llm-virtual-keys/:id",
      body: { success: true },
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-virtual-keys",
      body: makeVirtualKeysList({ keys: [] }),
    });

    await virtualKeysPage.deleteButtonFor(VK_NAME).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(virtualKeysPage.rowFor(VK_NAME)).toBeHidden();
  });
});
