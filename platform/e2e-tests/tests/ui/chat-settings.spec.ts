import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";
import { clickButton } from "../../utils";

const TEST_API_KEY = "sk-ant-test-key-12345";

test.describe("Chat API Keys", () => {
  test.describe.configure({ mode: "serial" });

  test("Admin can CRUD API keys", async ({
    page,
    goToPage,
    makeRandomString,
  }) => {
    const keyName = makeRandomString(8, "Test Key");
    const updatedName = makeRandomString(8, "Updated Test Key");

    // Navigate and wait for page to load
    await goToPage(page, "/settings/chat");

    // Click Add API Key button
    await page.getByTestId(E2eTestId.AddChatApiKeyButton).click();

    // Verify dialog is open
    await expect(
      page.getByRole("heading", { name: /Add API Key/i }),
    ).toBeVisible();

    // Fill in the form
    await page.getByLabel(/Name/i).fill(keyName);

    // Provider should be Anthropic by default
    await expect(
      page.getByRole("combobox", { name: "Provider" }),
    ).toContainText("Anthropic");

    // Fill in API key
    await page.getByRole("textbox", { name: /API Key/i }).fill(TEST_API_KEY);

    // Click Create button
    await clickButton({ page, options: { name: "Test & Create" } });

    // Wait for the dialog to close and table to update
    await expect(page.getByText("API key created successfully")).toBeVisible({
      timeout: 5000,
    });

    // Verify the new key appears in the table
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${keyName}`),
    ).toBeVisible();

    // Click the edit button for the created key
    await page
      .getByTestId(`${E2eTestId.EditChatApiKeyButton}-${keyName}`)
      .click();

    // Update the name
    await page.getByLabel(/Name/i).clear();
    await page.getByLabel(/Name/i).fill(updatedName);
    await clickButton({ page, options: { name: "Test & Save" } });

    // Verify the name was updated
    await expect(page.getByText("API key updated successfully")).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${updatedName}`),
    ).toBeVisible();

    // Cleanup: Delete the created key
    await page
      .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${updatedName}`)
      .click();
    await clickButton({ page, options: { name: "Delete" } });
  });

  test.describe("Scope creation restrictions and visibility", () => {
    test("One personal scope can be created for each user for each provider and other user cannot see them", async ({
      adminPage,
      editorPage,
      goToPage,
      makeRandomString,
    }) => {
      const testKeyNames = [
        "Test Key 1",
        "Test Key 2",
        "Test Key 3",
        "Test Key 4",
      ].map((name) => makeRandomString(8, name));
      await goToPage(adminPage, "/settings/chat");

      // Admin create a personal scope for Anthropic
      await adminPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await adminPage.getByLabel(/Name/i).fill(testKeyNames[0]);
      await adminPage
        .getByRole("textbox", { name: /API Key/i })
        .fill(TEST_API_KEY);
      await clickButton({
        page: adminPage,
        options: { name: "Test & Create" },
      });
      await expect(
        adminPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Editor cannot see Admin's personal api key in the list
      await goToPage(editorPage, "/settings/chat");
      await expect(
        editorPage.getByTestId(`${E2eTestId.ChatApiKeyRow}-${testKeyNames[0]}`),
      ).not.toBeVisible();

      // Admin cannot create second personal scope for Anthropic and team scope is selected by default
      await adminPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await expect(
        adminPage.getByRole("combobox", { name: "Scope" }),
      ).toContainText("Team");
      await adminPage.getByRole("combobox", { name: "Scope" }).click();
      await expect(
        adminPage.getByText("Personal (already exists)"),
      ).toBeVisible();

      // But Admin can still create personal scope for OpenAI
      await goToPage(adminPage, "/settings/chat");
      await adminPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await adminPage.getByLabel(/Name/i).fill(testKeyNames[1]);
      await adminPage.getByRole("combobox", { name: "Provider" }).click();
      await adminPage.getByRole("option", { name: "OpenAI OpenAI" }).click();
      await adminPage
        .getByRole("textbox", { name: /API Key/i })
        .fill(TEST_API_KEY);
      await clickButton({
        page: adminPage,
        options: { name: "Test & Create" },
      });
      await expect(
        adminPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Then editor create a personal scope for Anthropic
      await goToPage(editorPage, "/settings/chat");
      await editorPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await editorPage.getByLabel(/Name/i).fill(testKeyNames[2]);
      await editorPage
        .getByRole("textbox", { name: /API Key/i })
        .fill(TEST_API_KEY);
      await clickButton({
        page: editorPage,
        options: { name: "Test & Create" },
      });
      await expect(
        editorPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Admin cannot see Editor's personal scope in the list
      await goToPage(adminPage, "/settings/chat");
      await expect(
        adminPage.getByTestId(`${E2eTestId.ChatApiKeyRow}-${testKeyNames[2]}`),
      ).not.toBeVisible();

      // Editor cannot create second personal scope for Anthropic
      await editorPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await expect(
        editorPage.getByRole("combobox", { name: "Scope" }),
      ).toContainText("Team");
      await editorPage.getByRole("combobox", { name: "Scope" }).click();
      await expect(
        editorPage.getByText("Personal (already exists)"),
      ).toBeVisible();

      // But he can create personal scope for OpenAI
      await goToPage(editorPage, "/settings/chat");
      await editorPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await editorPage.getByLabel(/Name/i).fill(testKeyNames[3]);
      await editorPage.getByRole("combobox", { name: "Provider" }).click();
      await editorPage.getByRole("option", { name: "OpenAI OpenAI" }).click();
      await editorPage
        .getByRole("textbox", { name: /API Key/i })
        .fill(TEST_API_KEY);
      await clickButton({
        page: editorPage,
        options: { name: "Test & Create" },
      });
      await expect(
        editorPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // cleanup: delete the created keys
      for (const [idx, name] of testKeyNames.entries()) {
        const page = [0, 1].includes(idx) ? adminPage : editorPage;
        await page
          .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${name}`)
          .click();
        await clickButton({ page, options: { name: "Delete" } });
      }
    });

    test("One team scope for each team, only team members can see them", async ({
      adminPage,
      editorPage,
      memberPage,
      goToPage,
      makeRandomString,
    }) => {
      const testKeyName = makeRandomString(8, "Test Key");
      await goToPage(editorPage, "/settings/chat");

      // Editor create a team scope key for Engineering team
      await editorPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await editorPage.getByLabel(/Name/i).fill(testKeyName);
      await editorPage.getByRole("combobox", { name: "Scope" }).click();
      await editorPage.getByRole("option", { name: "Team" }).click();
      await editorPage.getByRole("combobox", { name: "Team" }).click();
      await editorPage.getByRole("option", { name: "Engineering" }).click();
      await editorPage
        .getByRole("textbox", { name: /API Key/i })
        .fill(TEST_API_KEY);
      await clickButton({
        page: editorPage,
        options: { name: "Test & Create" },
      });
      await expect(
        editorPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Editor and Admin can see it but Member cannot (he is not a member of the Engineering team)
      await goToPage(editorPage, "/settings/chat");
      await expect(
        editorPage.getByTestId(`${E2eTestId.ChatApiKeyRow}-${testKeyName}`),
      ).toBeVisible();
      await goToPage(adminPage, "/settings/chat");
      await expect(
        adminPage.getByTestId(`${E2eTestId.ChatApiKeyRow}-${testKeyName}`),
      ).toBeVisible();
      await goToPage(memberPage, "/settings/chat");
      await expect(
        memberPage.getByTestId(`${E2eTestId.ChatApiKeyRow}-${testKeyName}`),
      ).not.toBeVisible();

      // Editor cannot create second team scope for Engineering team
      await goToPage(editorPage, "/settings/chat");
      await editorPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await editorPage.getByRole("combobox", { name: "Scope" }).click();
      await editorPage.getByRole("option", { name: "Team" }).click();
      await editorPage.getByRole("combobox", { name: "Team" }).click();
      await expect(
        editorPage.getByRole("option", { name: "Engineering Team" }),
      ).not.toBeVisible();

      // Cleanup: delete the created key
      await goToPage(editorPage, "/settings/chat");
      await editorPage
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${testKeyName}`)
        .click();
      await clickButton({ page: editorPage, options: { name: "Delete" } });
    });

    test("Only one org-wide key can be created, everyone can see it", async ({
      adminPage,
      editorPage,
      memberPage,
      goToPage,
      makeRandomString,
    }) => {
      const testKeyName = makeRandomString(8, "Test Key");
      await goToPage(adminPage, "/settings/chat");

      // Admin create an org-wide key
      await adminPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await adminPage.getByLabel(/Name/i).fill(testKeyName);
      await adminPage.getByRole("combobox", { name: "Scope" }).click();
      await adminPage
        .getByRole("option", { name: "Whole Organization" })
        .click();
      await adminPage
        .getByRole("textbox", { name: /API Key/i })
        .fill(TEST_API_KEY);
      await clickButton({
        page: adminPage,
        options: { name: "Test & Create" },
      });
      await expect(
        adminPage.getByText("API key created successfully"),
      ).toBeVisible({
        timeout: 5000,
      });

      // Every user can see it
      for (const p of [adminPage, editorPage, memberPage]) {
        await goToPage(p, "/settings/chat");
        await p.waitForLoadState("networkidle");
        await expect(
          p.getByTestId(`${E2eTestId.ChatApiKeyRow}-${testKeyName}`),
        ).toBeVisible();
      }

      // Second org-wide key cannot be created
      await adminPage.getByTestId(E2eTestId.AddChatApiKeyButton).click();
      await adminPage.getByRole("combobox", { name: "Scope" }).click();
      await expect(
        adminPage.getByText("Whole Organization (already exists)"),
      ).toBeVisible();

      // Cleanup: delete the created key
      await goToPage(adminPage, "/settings/chat");
      await adminPage
        .getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${testKeyName}`)
        .click();
      await clickButton({ page: adminPage, options: { name: "Delete" } });
    });
  });
});
