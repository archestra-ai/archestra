import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";

test.describe("Chat Settings UI", () => {
  test.beforeEach(async ({ page, goToPage }) => {
    // Navigate to home first to ensure we're in a good state
    try {
      await goToPage(page, "/");
      // Skip onboarding if dialog is present
      const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
      if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await skipButton.click();
        await page.waitForTimeout(500);
      }
    } catch (_error) {
      // If navigation fails, try to recover by waiting
      await page.waitForTimeout(1000);
    }
  });

  test("should navigate to chat settings page", async ({ page, goToPage }) => {
    await goToPage(page, "/settings/chat");

    // Wait for page to be fully loaded
    await expect(
      page.getByRole("heading", { name: /LLM Provider API Keys/i }),
    ).toBeVisible({ timeout: 10000 });

    // Verify the Add API Key button is visible
    await expect(page.getByTestId(E2eTestId.AddChatApiKeyButton)).toBeVisible();
  });

  test(
    "should create a new API key",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const keyName = makeRandomString(8, "Test Key");

      // Navigate and wait for page to load
      await goToPage(page, "/settings/chat");
      await expect(
        page.getByRole("heading", { name: /LLM Provider API Keys/i }),
      ).toBeVisible({ timeout: 10000 });

      // Click Add API Key button
      await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();

      // Verify dialog is open
      await expect(
        page.getByRole("heading", { name: /Add API Key/i }),
      ).toBeVisible();

      // Fill in the form
      await page.getByLabel(/Name/i).fill(keyName);

      // Provider should be Anthropic by default
      await expect(page.getByRole("combobox")).toContainText("Anthropic");

      // Fill in API key
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-test-key-12345");

      // Click Create button
      await page.getByRole("button", { name: "Create" }).click();

      // Wait for the dialog to close and table to update
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Verify the new key appears in the table
      await expect(
        page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName}`),
      ).toBeVisible();

      // Cleanup: Delete the created key
      await page
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${keyName}`)
        .click();
      await page.getByRole("button", { name: "Delete" }).click();
    },
  );

  test(
    "should edit an API key name",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const originalName = makeRandomString(8, "Original");
      const updatedName = makeRandomString(8, "Updated");

      // Navigate and wait for page to load
      await goToPage(page, "/settings/chat");
      await expect(
        page.getByRole("heading", { name: /LLM Provider API Keys/i }),
      ).toBeVisible({ timeout: 10000 });

      // Create a key first
      await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await page.getByLabel(/Name/i).fill(originalName);
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-edit-test-key");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Click the edit button for the created key
      await page
        .getByTestId(`${E2eTestId.EditChatApiKeyButton}-${originalName}`)
        .click();

      // Update the name
      await page.getByLabel(/Name/i).clear();
      await page.getByLabel(/Name/i).fill(updatedName);
      await page.getByRole("button", { name: "Save" }).click();

      // Verify the name was updated
      await expect(page.getByText("API key updated successfully")).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${updatedName}`),
      ).toBeVisible();

      // Cleanup
      await page
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${updatedName}`)
        .click();
      await page.getByRole("button", { name: "Delete" }).click();
    },
  );

  test(
    "should delete an API key",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const keyName = makeRandomString(8, "Delete Me");

      // Navigate and wait for page to load
      await goToPage(page, "/settings/chat");
      await expect(
        page.getByRole("heading", { name: /LLM Provider API Keys/i }),
      ).toBeVisible({ timeout: 10000 });

      // Create a key first
      await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await page.getByLabel(/Name/i).fill(keyName);
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-delete-test-key");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Click the delete button for the created key
      await page
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${keyName}`)
        .click();

      // Confirm deletion
      await expect(
        page.getByText(`Are you sure you want to delete "${keyName}"`),
      ).toBeVisible();
      await page.getByRole("button", { name: "Delete" }).click();

      // Verify the key was deleted
      await expect(page.getByText("API key deleted successfully")).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName}`),
      ).not.toBeVisible();
    },
  );

  test(
    "should set an API key as organization default",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const keyName = makeRandomString(8, "Default Key");

      // Navigate and wait for page to load
      await goToPage(page, "/settings/chat");
      await expect(
        page.getByRole("heading", { name: /LLM Provider API Keys/i }),
      ).toBeVisible({ timeout: 10000 });

      // Create a key without setting it as default
      await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await page.getByLabel(/Name/i).fill(keyName);
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-default-test-key");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Click the set as default button
      await page
        .getByTestId(`${E2eTestId.SetDefaultChatApiKeyButton}-${keyName}`)
        .click();

      // Verify the success toast appears
      await expect(page.getByText("Set as organization default")).toBeVisible({
        timeout: 5000,
      });

      // Wait a bit for the UI to update
      await page.waitForTimeout(500);

      // The row should now show the Default badge
      await expect(
        page.getByTestId(`${E2eTestId.ChatApiKeyDefaultBadge}-${keyName}`),
      ).toBeVisible({ timeout: 5000 });

      // Cleanup
      await page
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${keyName}`)
        .click();
      await page.getByRole("button", { name: "Delete" }).click();
    },
  );
});
