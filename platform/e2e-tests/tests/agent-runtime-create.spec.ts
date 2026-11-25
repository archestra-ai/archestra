import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_NAMES,
  E2eTestId,
} from "@archestra/shared";
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
      name: /^Credentials to use/,
    });
    await expect(authenticationRow).toHaveAttribute("aria-expanded", "true");
    // The runtime's own setting is each person's Claude subscription, so a
    // new agent starts with that card alone, whatever connection its creator
    // has.
    const subscription = page.getByRole("checkbox", {
      name: /Each person's Claude subscription/,
    });
    const companyKey = page.getByRole("checkbox", {
      name: /An API key/,
    });
    await expect(subscription).toBeChecked();
    await expect(companyKey).not.toBeChecked();
    await expect(authenticationRow.getByRole("img")).toHaveCount(0);
    // With neither card ticked the row asks for one.
    await subscription.uncheck();
    await expect(subscription).not.toBeChecked();
    await expect(companyKey).not.toBeChecked();
    const attention = authenticationRow.getByRole("img", {
      name: "Choose who pays for its runs",
    });
    await expect(attention).toBeVisible();
    await attention.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Choose who pays for its runs",
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
    await subscription.check();
    await expect(subscription).toBeChecked();
    await expect(companyKey).not.toBeChecked();
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
      accountLock: "subscription",
      inferenceProtocol: "anthropic",
    });
    // Creating opens the agent's own page. Its account card says the
    // creator's runs use their own subscription, and offers the sign-in they
    // still need before the agent can run.
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
    const work = page.getByRole("region", { name: "Give it work" });
    await expect(
      work.getByText("Uses your personal subscription", { exact: true }),
    ).toBeVisible();
    await expect(
      work.getByRole("button", { name: "Sign in", exact: true }),
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

  const settingsUrl = `${UI_BASE_URL}/api/organization/integration-settings`;
  const templateSettingsUrl = `${UI_BASE_URL}/api/agent-runtime-templates/settings`;
  const templateResponse = await page.request.get(templateSettingsUrl);
  expect(templateResponse.ok()).toBe(true);
  const original = await templateResponse.json();
  const customCount = original.templates.filter(
    (template: { hidden: boolean }) => !template.hidden,
  ).length;
  const settings = page.getByRole("list", {
    name: "Available runtimes",
    exact: true,
  });
  const names = AGENT_CATALOG_IDS.map((id) => AGENT_CATALOG_NAMES[id]);
  const removedNames = names.filter(
    (name) => name !== "Claude Code" && name !== "Codex",
  );
  const actions = () => settings.getByRole("button", { name: /^Actions for / });
  // Every change to the list saves at once: wait for that save, and for the
  // list to take the next change.
  const saved = async (change: () => Promise<void>) => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/agent-runtime-templates/settings") &&
        r.request().method() === "PUT",
    );
    await change();
    expect((await response).ok()).toBe(true);
    await expect(
      page.getByRole("button", { name: "Add runtime", exact: true }),
    ).toBeEnabled();
  };
  const remove = (name: string) =>
    saved(async () => {
      await settings
        .getByRole("button", { name: `Actions for ${name}`, exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Remove from list", exact: true })
        .click();
    });

  try {
    expect(
      (
        await page.request.patch(settingsUrl, {
          data: { popularAgentOverrides: null },
        })
      ).ok(),
    ).toBe(true);
    await goToPage(page, "/settings/agents/runtimes");
    await expect(actions()).toHaveCount(names.length + customCount);
    for (const name of removedNames) await remove(name);
    await page.reload();
    await expect(actions()).toHaveCount(2 + customCount);

    await goToPage(page, "/agents/new");
    for (const name of removedNames) {
      await expect(
        page.getByRole("button", { name: new RegExp(name) }),
      ).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /Codex/ })).toBeVisible();
    await page.getByRole("button", { name: /Claude Code/ }).click();
    await expect(page.getByRole("textbox", { name: /^Name\b/ })).toHaveValue(
      "Claude Code",
    );
    // A catalog choice supplies the runtime, without a second picker in the form.
    await goToPage(page, "/agents/new");
    await expect(
      page.getByRole("button", { name: /Custom image/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Built into .* for chat\./ })
      .click();
    await expect(page.getByRole("textbox", { name: /^Name\b/ })).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Runtime", exact: true }),
    ).toHaveCount(0);

    await goToPage(page, "/settings/agents/runtimes");
    await expect(actions()).toHaveCount(2 + customCount);
    for (const name of ["Claude Code", "Codex"]) await remove(name);
    // Hiding the built-ins preserves custom images and the other creation flows.
    await goToPage(page, "/agents/new");
    for (const name of names) {
      await expect(
        page.getByRole("button", { name: new RegExp(name) }),
      ).toHaveCount(0);
    }
    await expect(
      page.getByRole("button", { name: /Custom image/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Built into .* for chat\./ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Connect via A2A/ }),
    ).toBeVisible();

    await goToPage(page, "/settings/agents/runtimes");
    for (const name of names) {
      await saved(async () => {
        await page
          .getByRole("button", { name: "Add runtime", exact: true })
          .click();
        await page.getByRole("menuitem", { name: new RegExp(name) }).click();
      });
    }
    await goToPage(page, "/agents/new");
    for (const name of names)
      await expect(
        page.getByRole("button", { name: new RegExp(name) }),
      ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Custom image/ }),
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
