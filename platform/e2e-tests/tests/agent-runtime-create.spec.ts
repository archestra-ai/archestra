import { E2eTestId } from "@archestra/shared";
import { mergeTests } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test as uiTest } from "../fixtures";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

test("creates Claude Code from the catalog and explains the account connection after saving", async ({
  page,
  request,
  goToPage,
  makeRandomString,
  deleteAgent,
}) => {
  const configResponse = await page.request.get(`${UI_BASE_URL}/api/config`);
  expect(configResponse.ok()).toBe(true);
  const config = await configResponse.json();
  test.skip(
    !config.features?.agentRuntime,
    "Requires an Agent Runtime backend",
  );

  let agentId: string | undefined;
  try {
    await goToPage(page, "/agents/new");
    const name = makeRandomString(10, "Runtime create");
    const nameField = page.getByRole("textbox", { name: /^Name\b/ });
    const claudeCard = page.getByRole("button", { name: /Claude Code/ });
    await expect(async () => {
      if (await claudeCard.isVisible()) await claudeCard.click();
      await expect(nameField).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });

    const nextButton = page.getByTestId(E2eTestId.AgentSetupNextButton);
    await expect(async () => {
      await nameField.fill(name);
      await expect(nextButton).toBeEnabled({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(
      page.getByRole("radio", { name: /Claude Code/ }),
    ).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "Archestra Agent", exact: true }),
    ).toHaveCount(0);
    const authenticationRow = page.getByRole("button", {
      name: /^Authentication/,
    });
    await expect(authenticationRow).toHaveAttribute("aria-expanded", "true");
    await expect(authenticationRow.getByRole("img")).toHaveCount(0);
    await page
      .getByRole("radio", { name: /API key or cloud provider/ })
      .click();
    const attention = authenticationRow.getByRole("img", {
      name: "Select a provider and Claude model",
    });
    await expect(attention).toBeVisible();
    await attention.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Select a provider and Claude model",
    );
    const iconBounds = await attention.boundingBox();
    await expect(async () => {
      const tooltipBounds = await page
        .locator('[data-slot="tooltip-content"]')
        .boundingBox();
      expect(iconBounds).not.toBeNull();
      expect(tooltipBounds).not.toBeNull();
      if (!iconBounds || !tooltipBounds)
        throw new Error("Missing tooltip or icon bounds");
      expect(
        Math.abs(
          tooltipBounds.x +
            tooltipBounds.width / 2 -
            (iconBounds.x + iconBounds.width / 2),
        ),
      ).toBeLessThan(4);
      expect(tooltipBounds.y + tooltipBounds.height).toBeLessThanOrEqual(
        iconBounds.y,
      );
    }).toPass();
    await expect(
      page.getByRole("button", { name: "Select a Claude model" }),
    ).toBeVisible();
    await page
      .getByRole("radio", { name: /Personal Claude subscription/ })
      .click();
    await expect(authenticationRow.getByRole("img")).toHaveCount(0);

    const submitButton = page.getByTestId(E2eTestId.AgentSetupSubmitButton);
    await expect(async () => {
      if (await submitButton.isVisible()) return;
      await nextButton.click();
      await expect(submitButton).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/agents") &&
        response.request().method() === "POST",
    );
    await submitButton.click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const created = await response.json();
    agentId = created.id;
    expect(created.runtime).toMatchObject({
      command: ["archestra-claude-code"],
      claudeCode: { authentication: "subscription" },
      inferenceProtocol: "anthropic",
    });
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/created$`));
    await expect(
      page.getByRole("heading", { name: "Agent created", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Before this agent can run", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Connect your Claude account", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  } finally {
    if (agentId) await deleteAgent(request, agentId);
  }
});
