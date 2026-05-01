import { E2eTestId } from "@shared";
import { expect, test } from "../fixtures";
import { clickButton, waitForElementWithReload } from "../utils";

test("can create an agent from template catalog", {
  tag: ["@firefox", "@webkit"],
}, async ({ page, makeRandomString, goToPage }) => {
  test.setTimeout(120_000);

  await goToPage(page, "/agents");
  await page.waitForLoadState("domcontentloaded");

  const createButton = page.getByTestId(E2eTestId.CreateAgentButton);
  await waitForElementWithReload(page, createButton);
  await createButton.click();

  await page
    .getByRole("button", { name: "Select from Template Catalog" })
    .click();

  // Template catalog is rendered inside the create dialog
  await expect(
    page.getByRole("button", { name: "Use as Template" }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // Use the general-purpose template (safe in prod, no tools)
  await page
    .getByRole("heading", { name: "General Purpose Agent" })
    .locator("..")
    .getByRole("button", { name: "Use as Template" })
    .click();

  // Verify prefills applied
  const nameInput = page.getByRole("textbox", { name: "Name" });
  await expect(nameInput).toHaveValue("General Purpose Agent");

  const agentName = makeRandomString(6, "General Purpose Agent");
  await nameInput.fill(agentName);

  await page.getByRole("button", { name: "Create" }).click();

  // Wait for the create dialog to close
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded");

  // Poll for the agent to appear in the table
  const agentLocator = page
    .getByTestId(E2eTestId.AgentsTable)
    .getByTitle(agentName);

  await waitForElementWithReload(page, agentLocator, {
    timeout: 30_000,
    intervals: [2000, 3000, 5000],
    checkEnabled: false,
  });

  // Cleanup: delete created agent
  await page
    .getByTestId(`${E2eTestId.DeleteAgentButton}-${agentName}`)
    .click();
  await clickButton({ page, options: { name: "Delete Agent" } });
  await expect(agentLocator).not.toBeVisible({ timeout: 10_000 });
});

