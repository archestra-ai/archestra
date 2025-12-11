import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";

test.describe("Chat Settings UI", () => {
  test.beforeEach(async ({ page, goToPage }) => {
    // Skip onboarding if dialog is present
    await goToPage(page, "/");
    const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
      await page.waitForTimeout(500);
    }
  });

  test("should navigate to chat settings page", async ({ page, goToPage }) => {
    await goToPage(page, "/settings/chat");

    // Verify the page title
    await expect(
      page.getByRole("heading", { name: /LLM Provider API Keys/i }),
    ).toBeVisible();

    // Verify the Add API Key button is visible
    await expect(
      page.getByRole("button", { name: /Add API Key/i }),
    ).toBeVisible();
  });

  test(
    "should create a new API key",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const keyName = makeRandomString(8, "Test Key");

      await goToPage(page, "/settings/chat");

      // Click Add API Key button
      await page.getByRole("button", { name: /Add API Key/i }).click();

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
      await expect(page.getByText(keyName)).toBeVisible();

      // Cleanup: Delete the created key
      await page
        .getByRole("row")
        .filter({ hasText: keyName })
        .getByRole("button")
        .last()
        .click();
      await page.getByRole("menuitem", { name: /Delete/i }).click();
      await page.getByRole("button", { name: "Delete" }).click();
    },
  );

  test(
    "should edit an API key name",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const originalName = makeRandomString(8, "Original");
      const updatedName = makeRandomString(8, "Updated");

      await goToPage(page, "/settings/chat");

      // Create a key first
      await page.getByRole("button", { name: /Add API Key/i }).click();
      await page.getByLabel(/Name/i).fill(originalName);
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-edit-test-key");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Open the actions menu for the created key
      await page
        .getByRole("row")
        .filter({ hasText: originalName })
        .getByRole("button")
        .last()
        .click();
      await page.getByRole("menuitem", { name: /Edit/i }).click();

      // Update the name
      await page.getByLabel(/Name/i).clear();
      await page.getByLabel(/Name/i).fill(updatedName);
      await page.getByRole("button", { name: "Save" }).click();

      // Verify the name was updated
      await expect(page.getByText("API key updated successfully")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByText(updatedName)).toBeVisible();

      // Cleanup
      await page
        .getByRole("row")
        .filter({ hasText: updatedName })
        .getByRole("button")
        .last()
        .click();
      await page.getByRole("menuitem", { name: /Delete/i }).click();
      await page.getByRole("button", { name: "Delete" }).click();
    },
  );

  test(
    "should delete an API key",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const keyName = makeRandomString(8, "Delete Me");

      await goToPage(page, "/settings/chat");

      // Create a key first
      await page.getByRole("button", { name: /Add API Key/i }).click();
      await page.getByLabel(/Name/i).fill(keyName);
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-delete-test-key");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Open the actions menu and click delete
      await page
        .getByRole("row")
        .filter({ hasText: keyName })
        .getByRole("button")
        .last()
        .click();
      await page.getByRole("menuitem", { name: /Delete/i }).click();

      // Confirm deletion
      await expect(
        page.getByText(`Are you sure you want to delete "${keyName}"`),
      ).toBeVisible();
      await page.getByRole("button", { name: "Delete" }).click();

      // Verify the key was deleted
      await expect(page.getByText("API key deleted successfully")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByText(keyName)).not.toBeVisible();
    },
  );

  test(
    "should set an API key as organization default",
    { tag: ["@firefox", "@webkit"] },
    async ({ page, goToPage, makeRandomString }) => {
      const keyName = makeRandomString(8, "Default Key");

      await goToPage(page, "/settings/chat");

      // Create a key without setting it as default
      await page.getByRole("button", { name: /Add API Key/i }).click();
      await page.getByLabel(/Name/i).fill(keyName);
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-ant-default-test-key");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 5000,
      });

      // Open actions menu and set as default
      await page
        .getByRole("row")
        .filter({ hasText: keyName })
        .getByRole("button")
        .last()
        .click();
      await page.getByRole("menuitem", { name: /Set as Default/i }).click();

      // Verify the default badge appears
      await expect(page.getByText("Set as organization default")).toBeVisible({
        timeout: 5000,
      });

      // The row should now show the Default badge
      const keyRow = page.getByRole("row").filter({ hasText: keyName });
      await expect(keyRow.getByText("Default", { exact: true })).toBeVisible();

      // Cleanup
      await keyRow.getByRole("button").last().click();
      await page.getByRole("menuitem", { name: /Delete/i }).click();
      await page.getByRole("button", { name: "Delete" }).click();
    },
  );
});
