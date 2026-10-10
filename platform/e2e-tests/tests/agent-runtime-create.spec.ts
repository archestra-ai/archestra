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
    // Picked in the catalog, so the runtime is a summary, not a second picker.
    await expect(
      page.getByText("Claude Code in its own container", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Runtime", exact: true }),
    ).toHaveCount(0);
    const authenticationRow = page.getByRole("button", {
      name: /^Whose Claude account runs it/,
    });
    await expect(authenticationRow).toHaveAttribute("aria-expanded", "true");
    await expect(authenticationRow.getByRole("img")).toHaveCount(0);
    await page.getByRole("radio", { name: /A company API key/ }).click();
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
      page.getByRole("button", {
        name: /^(Select a Claude model|No models available)$/,
      }),
    ).toBeVisible();
    await page
      .getByRole("radio", { name: /Each person's Claude subscription/ })
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
    // Creating opens the agent's own page, which lists the missing Claude
    // account before the agent can run.
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
    await expect(
      page.getByText("Connect your Claude subscription", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in with Claude", exact: true }),
    ).toBeVisible();
  } finally {
    if (agentId) await deleteAgent(request, agentId);
  }
});

test("configures popular agent templates and preserves the creation wizard", async ({
  page,
  goToPage,
}) => {
  const configResponse = await page.request.get(`${UI_BASE_URL}/api/config`);
  expect(configResponse.ok()).toBe(true);
  const config = await configResponse.json();
  test.skip(
    !config.features?.agentRuntime,
    "Requires an Agent Runtime backend",
  );

  const organizationResponse = await page.request.get(
    `${UI_BASE_URL}/api/organization`,
  );
  expect(organizationResponse.ok()).toBe(true);
  const original = await organizationResponse.json();
  const settingsUrl = `${UI_BASE_URL}/api/organization/integration-settings`;
  const settings = page.getByRole("list", {
    name: "Coding agents",
    exact: true,
  });
  const names = ["Claude Code", "Codex", "OpenCode", "Hermes", "OpenClaw"];
  const save = async () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/organization/integration-settings") &&
        r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
  };

  try {
    expect(
      (
        await page.request.patch(settingsUrl, {
          data: { popularAgentOverrides: null },
        })
      ).ok(),
    ).toBe(true);
    await goToPage(page, "/settings/agents");
    await expect(
      settings.getByRole("button", { name: /^Remove / }),
    ).toHaveCount(5);
    for (const name of ["OpenCode", "Hermes", "OpenClaw"]) {
      await settings
        .getByRole("button", { name: `Remove ${name}`, exact: true })
        .click();
    }
    await save();
    await page.reload();
    await expect(
      settings.getByRole("button", { name: /^Remove / }),
    ).toHaveCount(2);

    await goToPage(page, "/agents/new");
    for (const name of ["OpenCode", "Hermes", "OpenClaw"]) {
      await expect(
        page.getByRole("button", { name: new RegExp(name) }),
      ).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /Codex/ })).toBeVisible();
    await page.getByRole("button", { name: /Claude Code/ }).click();
    await expect(page.getByRole("textbox", { name: /^Name\b/ })).toHaveValue(
      "Claude Code",
    );
    // The catalog's pick shows as a summary; the full runtime picker is on
    // the built-in agent's path.
    await goToPage(page, "/agents/new");
    await page.getByRole("button", { name: /^New .* agent/ }).click();
    const runtimeChoices = page.getByRole("radiogroup", {
      name: "Runtime",
      exact: true,
    });
    await expect(runtimeChoices.getByRole("radio")).toHaveCount(4);
    await expect(
      runtimeChoices.getByRole("radio", { name: "Codex", exact: true }),
    ).toBeVisible();
    await expect(
      runtimeChoices.getByRole("radio", { name: "Custom image", exact: true }),
    ).toBeVisible();
    for (const name of ["OpenCode", "Hermes", "OpenClaw"]) {
      await expect(
        runtimeChoices.getByRole("radio", { name, exact: true }),
      ).toHaveCount(0);
    }

    await goToPage(page, "/settings/agents");
    await expect(
      settings.getByRole("button", { name: /^Remove / }),
    ).toHaveCount(2);
    await settings
      .getByRole("button", { name: /^Remove / })
      .first()
      .click();
    await settings.getByRole("button", { name: /^Remove / }).click();
    await save();
    await goToPage(page, "/agents/new");
    await expect(
      page.getByRole("heading", { name: "Coding agents", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^New .* agent/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Connect via A2A/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^New .* agent/ }).click();
    await expect(runtimeChoices.getByRole("radio")).toHaveCount(2);
    await expect(
      runtimeChoices.getByRole("radio", { name: "Custom image", exact: true }),
    ).toBeVisible();

    await goToPage(page, "/settings/agents");
    for (const name of names) {
      await settings.getByRole("button", { name: "Add coding agent" }).click();
      await page.getByRole("button", { name, exact: true }).click();
    }
    await save();
    await goToPage(page, "/agents/new");
    for (const name of names)
      await expect(
        page.getByRole("button", { name: new RegExp(name) }),
      ).toBeVisible();
    await page.getByRole("button", { name: /^New .* agent/ }).click();
    await expect(runtimeChoices.getByRole("radio")).toHaveCount(7);
    for (const name of names)
      await expect(
        runtimeChoices.getByRole("radio", { name, exact: true }),
      ).toBeVisible();
  } finally {
    expect(
      (
        await page.request.patch(settingsUrl, {
          data: { popularAgentOverrides: original.popularAgentOverrides },
        })
      ).ok(),
    ).toBe(true);
  }
});
