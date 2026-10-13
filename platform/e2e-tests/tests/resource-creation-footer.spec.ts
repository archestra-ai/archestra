import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import { defineResourceCreationFooterTests } from "./resource-creation-footer";

// Plugins follow ARCHESTRA_BETA, which this stack keeps off:
// openappa/plugin-creation-footer.spec.ts covers them on the beta stack.
defineResourceCreationFooterTests(["skills", "mcp/registry"]);

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
