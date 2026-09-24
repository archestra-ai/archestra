import type { Locator, Page } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 640 },
  { width: 320, height: 568 },
  { width: 280, height: 653 },
]) {
  for (const resource of ["skills", "plugins", "mcp/registry"] as const) {
    test(`keeps ${resource} create and edit actions reachable at ${viewport.width}px`, async ({
      page,
      goToPage,
      makeRandomString,
    }, testInfo) => {
      const isMcp = resource === "mcp/registry";
      const apiPath = isMcp ? "internal_mcp_catalog" : resource;
      const name = makeRandomString(8, "release-checklist");
      const description = "Review the release checklist before publishing.";
      let createdId: string | undefined;
      let creates = 0;
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname === `/api/${apiPath}` &&
          request.method() === "POST"
        )
          creates++;
      });
      await page.setViewportSize(viewport);
      await page.addInitScript(() => localStorage.setItem("theme", "dark"));
      await goToPage(page, `/${resource}/new`);
      const nameField = page.getByRole("textbox", {
        name:
          resource === "skills"
            ? "Skill name"
            : resource === "plugins"
              ? "Display name"
              : /^Name\b/,
      });
      const source = page.getByRole("button", {
        name: isMcp ? /Start from scratch/ : /Blank template/,
      });
      await expect(nameField.or(source)).toBeVisible();
      await expect(async () => {
        if (!(await nameField.isVisible())) await source.click();
        await expect(nameField).toBeVisible({ timeout: 2_000 });
      }).toPass();
      const create = page.getByRole("button", {
        name: isMcp
          ? "Add Server"
          : resource === "skills"
            ? "Create skill"
            : "Create plugin",
        exact: true,
      });
      try {
        if (!isMcp) await expect(create).toBeDisabled();
        await nameField.fill(name);
        await page.getByLabel("Description", { exact: true }).fill(description);
        if (isMcp)
          await page
            .getByRole("textbox", { name: /^Server URL/ })
            .fill("https://example.com/mcp");
        await expect(create).toBeEnabled();
        const createStyle = await footerStyle(create);
        expect(createStyle.position).toBe(
          viewport.width < 640 ? "static" : "sticky",
        );
        await expectReachableActions({
          page,
          actions: [
            create,
            page.getByRole("button", { name: "Back", exact: true }),
          ],
        });
        if (isMcp) {
          // The header may scroll horizontally; unlike the footer actions,
          // its steps need to be reachable rather than all visible at once.
          const lastStep = page.getByRole("button", {
            name: /^Step 3 of 3:/,
          });
          await lastStep.scrollIntoViewIfNeeded();
          await lastStep.focus();
          await expect(lastStep).toBeFocused();
          await expect(lastStep).toBeInViewport({ ratio: 1 });
        }
        // Returning to Source must not submit. Skills and plugins retain their draft.
        await clickVisible({
          page,
          button: page.getByRole("button", { name: "Back", exact: true }),
        });
        await expect(source).toBeVisible();
        expect(creates).toBe(0);
        await source.click();
        if (isMcp) {
          await nameField.fill(name);
          await page
            .getByLabel("Description", { exact: true })
            .fill(description);
          await page
            .getByRole("textbox", { name: /^Server URL/ })
            .fill("https://example.com/mcp");
        } else {
          await expect(nameField).toHaveValue(name);
          await expect(
            page.getByLabel("Description", { exact: true }),
          ).toHaveValue(description);
        }
        await page.screenshot({ path: testInfo.outputPath("create.png") });
        const createdResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/${apiPath}` &&
            response.request().method() === "POST",
        );
        await clickVisible({ page, button: create });
        const response = await createdResponse;
        expect(response.ok(), await response.text()).toBe(true);
        createdId = (await response.json()).id;
        expect(creates).toBe(1);
        await expect(page).toHaveURL(
          new RegExp(
            `/${resource}/${createdId}${isMcp ? "/edit\\?step=test" : "(\\?section=settings)?"}$`,
          ),
        );
        // Exercise legacy skill/plugin edit links as well as the actual editor.
        await goToPage(page, `/${resource}/${createdId}/edit`);
        await expect(nameField).toHaveValue(name);
        const save = page.getByRole("button", { name: "Save", exact: true });
        const discard = page.getByRole("button", {
          name: "Discard changes",
          exact: true,
        });
        if (!isMcp) await expect(save).toBeDisabled();
        expect(await footerStyle(save)).toEqual(createStyle);
        const descriptionField = page.getByLabel("Description", {
          exact: true,
        });
        await descriptionField.fill("Unsaved draft to discard.");
        await expect(save).toBeEnabled();
        await expectReachableActions({
          page,
          actions: [
            discard,
            save,
            ...(isMcp
              ? [
                  page.getByRole("button", {
                    name: "Save & Continue",
                    exact: true,
                  }),
                ]
              : []),
          ],
        });
        await clickVisible({ page, button: discard });
        await expect(descriptionField).toHaveValue(description);
        await expect(discard).toBeHidden();
        await descriptionField.fill("Updated release checklist instructions.");
        await page.screenshot({ path: testInfo.outputPath("edit.png") });
        const savedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/${apiPath}/${createdId}` &&
            response.request().method() === "PUT",
        );
        await clickVisible({ page, button: save });
        expect((await savedResponse).ok()).toBe(true);
        await expect(page).toHaveURL(
          new RegExp(`/${resource}/${createdId}(\\?section=settings)?$`),
        );
        await goToPage(page, `/${resource}/${createdId}/edit`);
        await expect(descriptionField).toHaveValue(
          "Updated release checklist instructions.",
        );
        if (isMcp) {
          await descriptionField.fill(
            "Continue to connection testing after saving.",
          );
          const continuedResponse = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
                `/api/${apiPath}/${createdId}` &&
              response.request().method() === "PUT",
          );
          await clickVisible({
            page,
            button: page.getByRole("button", {
              name: "Save & Continue",
              exact: true,
            }),
          });
          expect((await continuedResponse).ok()).toBe(true);
          await expect(page).toHaveURL(/\/edit\?step=test$/);
          await goToPage(page, `/${resource}/${createdId}/edit`);
          await expect(descriptionField).toHaveValue(
            "Continue to connection testing after saving.",
          );
        } else {
          await expect(save).toBeDisabled();
        }
      } finally {
        if (createdId) {
          const deleted = await page.request.delete(
            `${UI_BASE_URL}/api/${apiPath}/${createdId}`,
          );
          expect(deleted.ok()).toBe(true);
        }
      }
    });
  }
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
test("keeps idle-hibernation configuration inside narrow registry forms", async ({
  page,
  goToPage,
  makeRandomString,
}, testInfo) => {
  const config = await (
    await page.request.get(`${UI_BASE_URL}/api/config`)
  ).json();
  test.skip(
    !config.features?.mcpIdleHibernationBetaEnabled ||
      !config.enterpriseFeatures?.core,
    "Requires idle-hibernation beta and enterprise core",
  );
  const organization = await (
    await page.request.get(`${UI_BASE_URL}/api/organization`)
  ).json();
  let catalogId: string | undefined;
  let serverId: string | undefined;
  try {
    const enabled = await page.request.patch(
      `${UI_BASE_URL}/api/organization/mcp-settings`,
      { data: { mcpIdleHibernationEnabled: true } },
    );
    expect(enabled.ok()).toBe(true);
    const created = await page.request.post(
      `${UI_BASE_URL}/api/internal_mcp_catalog`,
      {
        data: {
          name: makeRandomString(8, "idle-form"),
          serverType: "local",
          localConfig: { command: "node", arguments: ["server.js"] },
        },
      },
    );
    expect(created.ok(), await created.text()).toBe(true);
    catalogId = (await created.json()).id;
    const installed = await page.request.post(`${UI_BASE_URL}/api/mcp_server`, {
      data: { catalogId, name: "Idle form check", scope: "personal" },
    });
    expect(installed.ok(), await installed.text()).toBe(true);
    serverId = (await installed.json()).id;
    for (const width of [1280, 390, 280]) {
      await page.setViewportSize({ width, height: 720 });
      await goToPage(page, `/mcp/registry/${catalogId}/edit`);
      const selector = page.getByRole("combobox", {
        name: "Idle hibernation",
      });
      await expect(selector).toHaveText("Inherit organization setting");
      await expect(selector).toBeEnabled();
      await expect(selector).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: testInfo.outputPath(`hibernation-${width}.png`),
      });
    }
  } finally {
    if (serverId) {
      const uninstalled = await page.request.delete(
        `${UI_BASE_URL}/api/mcp_server/${serverId}`,
      );
      expect(uninstalled.ok()).toBe(true);
    }
    const restored = await page.request.patch(
      `${UI_BASE_URL}/api/organization/mcp-settings`,
      {
        data: {
          mcpIdleHibernationEnabled:
            organization.mcpIdleHibernationEnabled ?? false,
        },
      },
    );
    expect(restored.ok()).toBe(true);
    if (catalogId) {
      const deleted = await page.request.delete(
        `${UI_BASE_URL}/api/internal_mcp_catalog/${catalogId}`,
      );
      expect(deleted.ok()).toBe(true);
    }
  }
});
// SPDX-SnippetEnd

async function expectReachableActions({
  page,
  actions,
}: {
  page: Page;
  actions: Locator[];
}) {
  const viewport = page.viewportSize();
  const mobile = !!viewport && viewport.width < 640;
  const scroll =
    viewport && viewport.width < 768
      ? page.getByRole("main")
      : page.locator("[data-page-scroll-container]");
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeGreaterThan(100);
  for (const fraction of [0, 0.5, 1]) {
    await scroll.evaluate((element, fraction) => {
      element.scrollTop =
        (element.scrollHeight - element.clientHeight) * fraction;
    }, fraction);
    if (!mobile || fraction === 1)
      for (const action of actions)
        await expect(action).toBeInViewport({ ratio: 1 });
  }
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  // The last fields must be reachable above the footer at the bottom.
  const labels = page.getByLabel("Label key", { exact: true });
  await expect(labels).toBeInViewport({ ratio: 1 });
  const labelsBox = await labels.boundingBox();
  const firstActionBox = await actions[0].boundingBox();
  expect(
    labelsBox &&
      firstActionBox &&
      labelsBox.y + labelsBox.height <= firstActionBox.y,
  ).toBe(true);
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
}

async function footerStyle(button: Locator) {
  return button.evaluate((element) => {
    const footer = element.closest("[data-wizard-footer]");
    if (!footer) throw new Error("Action footer is missing");
    const style = getComputedStyle(footer);
    return {
      background: style.backgroundColor,
      border: style.border,
      padding: style.padding,
      bottom: style.bottom,
      position: style.position,
    };
  });
}

async function clickVisible({ page, button }: { page: Page; button: Locator }) {
  await expect(button).toBeEnabled();
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 640) await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  const box = await button.boundingBox();
  if (!box) throw new Error("Action is missing");
  // Keep the visibility assertion explicit after mobile scrolling.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
