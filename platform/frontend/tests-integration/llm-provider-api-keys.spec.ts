import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

const PROVIDER = "anthropic" as const;
const PROVIDER_OPTION_NAME = "Anthropic Anthropic";
const API_KEY_PLACEHOLDER = "sk-ant-test-key-12345";

test.describe.configure({ mode: "serial" });

test.describe("LLM Provider API Keys", () => {
  test("Admin can create, update, and delete an API key", async ({
    page,
    llmKeysPage,
    mswControl,
  }) => {
    const KEY_NAME = "Test Key";
    const UPDATED_NAME = "Renamed Test Key";
    const created = makeLlmProviderApiKey({
      id: "llm-key-1",
      name: KEY_NAME,
      provider: PROVIDER,
    });

    await mswControl.use({
      method: "post",
      url: "/api/llm-provider-api-keys",
      body: created,
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [created],
    });

    await llmKeysPage.goto();
    await llmKeysPage.addButton.click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: PROVIDER_OPTION_NAME }).click();
    await page.getByLabel(/^Name/).fill(KEY_NAME);
    await page
      .getByRole("textbox", { name: /API Key/i })
      .fill(API_KEY_PLACEHOLDER);
    await page.getByRole("button", { name: "Test & Create" }).click();

    await expect(llmKeysPage.rowFor(KEY_NAME)).toBeVisible();

    // Update flow — stage the PATCH and the post-update list refetch.
    const updated = { ...created, name: UPDATED_NAME };
    await mswControl.use({
      method: "patch",
      url: "/api/llm-provider-api-keys/:id",
      body: updated,
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [updated],
    });

    await llmKeysPage.editButtonFor(KEY_NAME).click();
    const editName = page.getByLabel(/^Name/);
    await editName.clear();
    await editName.fill(UPDATED_NAME);
    await page.getByRole("button", { name: "Test & Save" }).click();
    await expect(llmKeysPage.rowFor(UPDATED_NAME)).toBeVisible();

    // Delete — stage empty list refetch ahead of the click.
    await mswControl.use({
      method: "delete",
      url: "/api/llm-provider-api-keys/:id",
      body: { success: true },
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [],
    });

    await llmKeysPage.deleteButtonFor(UPDATED_NAME).click();
    await page.getByRole("button", { name: "Delete API Key" }).click();
    await expect(llmKeysPage.rowFor(UPDATED_NAME)).toBeHidden();
  });

  test("Can create multiple keys for the same provider and scope", async ({
    page,
    llmKeysPage,
    mswControl,
  }) => {
    const KEY_A = "Multi Key A";
    const KEY_B = "Multi Key B";
    const a = makeLlmProviderApiKey({
      id: "llm-key-a",
      name: KEY_A,
      provider: PROVIDER,
      isPrimary: true,
    });
    const b = makeLlmProviderApiKey({
      id: "llm-key-b",
      name: KEY_B,
      provider: PROVIDER,
      isPrimary: false,
    });

    await mswControl.use({
      method: "post",
      url: "/api/llm-provider-api-keys",
      body: a,
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [a],
    });

    await llmKeysPage.goto();
    await llmKeysPage.addButton.click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: PROVIDER_OPTION_NAME }).click();
    await page.getByLabel(/^Name/).fill(KEY_A);
    await page
      .getByRole("textbox", { name: /API Key/i })
      .fill(API_KEY_PLACEHOLDER);
    await page.getByRole("button", { name: "Test & Create" }).click();
    await expect(llmKeysPage.rowFor(KEY_A)).toBeVisible();

    await mswControl.use({
      method: "post",
      url: "/api/llm-provider-api-keys",
      body: b,
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [a, b],
    });

    await llmKeysPage.addButton.click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: PROVIDER_OPTION_NAME }).click();
    await page.getByLabel(/^Name/).fill(KEY_B);
    await page
      .getByRole("textbox", { name: /API Key/i })
      .fill(API_KEY_PLACEHOLDER);
    await page.getByRole("button", { name: "Test & Create" }).click();

    await expect(llmKeysPage.rowFor(KEY_A)).toBeVisible();
    await expect(llmKeysPage.rowFor(KEY_B)).toBeVisible();
  });

  test("First key for a provider defaults to primary, subsequent does not", async ({
    page,
    llmKeysPage,
    mswControl,
  }) => {
    const PRIMARY = "Primary Key";
    const SECONDARY = "Secondary Key";
    // Admin permission is granted in the test fixture, so the create-dialog
    // defaults to scope=org. Match it on the mock so `hasAnyKeyForProvider`
    // in LlmProviderApiKeyForm detects the existing primary.
    const primary = makeLlmProviderApiKey({
      id: "llm-key-primary",
      name: PRIMARY,
      provider: PROVIDER,
      isPrimary: true,
      scope: "org",
      userId: null,
    });

    // Start with no keys so the primary toggle defaults on.
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [],
    });

    await llmKeysPage.goto();
    await llmKeysPage.addButton.click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: PROVIDER_OPTION_NAME }).click();
    await page.getByLabel(/^Name/).fill(PRIMARY);
    await page
      .getByRole("textbox", { name: /API Key/i })
      .fill(API_KEY_PLACEHOLDER);

    const primarySwitch = page.getByRole("switch", { name: /Primary key/i });
    await expect(primarySwitch).toBeChecked();

    // Create the first key — stage POST and list refetch.
    await mswControl.use({
      method: "post",
      url: "/api/llm-provider-api-keys",
      body: primary,
    });
    await mswControl.use({
      method: "get",
      url: "/api/llm-provider-api-keys",
      body: [primary],
    });

    await page.getByRole("button", { name: "Test & Create" }).click();
    await expect(llmKeysPage.rowFor(PRIMARY)).toBeVisible();

    // Open dialog again for a second key on the same provider — primary
    // toggle should be off and disabled.
    await llmKeysPage.addButton.click();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: PROVIDER_OPTION_NAME }).click();
    await page.getByLabel(/^Name/).fill(SECONDARY);
    await page
      .getByRole("textbox", { name: /API Key/i })
      .fill(API_KEY_PLACEHOLDER);

    const secondarySwitch = page.getByRole("switch", { name: /Primary key/i });
    await expect(secondarySwitch).not.toBeChecked();
    await expect(secondarySwitch).toBeDisabled();
    await expect(
      page.getByText(new RegExp(`"${PRIMARY}" is already the primary key`)),
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
  });
});
