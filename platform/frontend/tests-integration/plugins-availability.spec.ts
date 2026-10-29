import { expect, test } from "./fixtures";

test("plugins navigation and authoring work with beta disabled", async ({
  page,
  mswControl,
  request,
}) => {
  const config = await (await request.get("/internal-test/api/config")).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: {
        ...config,
        features: { ...config.features, betaEnabled: false, plugins: false },
      },
    },
    { method: "get", url: "/api/plugins", body: [] },
  ]);
  await page.goto("/plugins");
  await expect(
    page.getByRole("heading", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Plugins", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "Add your first plugin" }).click();
  await page.getByRole("button", { name: /Blank template/ }).click();
  await expect(page).toHaveURL(/\/plugins\/new/);
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Plugins are disabled for this deployment."),
  ).toHaveCount(0);
});

test("Skills shows plugin-backed instructions with beta disabled", async ({
  page,
  mswControl,
  request,
}) => {
  const config = await (await request.get("/internal-test/api/config")).json();
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: {
        ...config,
        features: { ...config.features, betaEnabled: false, plugins: false },
      },
    },
    {
      method: "get",
      url: "/api/skills/plugins",
      body: [
        {
          source: "plugin",
          pluginId: "11111111-1111-4111-8111-111111111111",
          pluginName: "Writing bundle",
          pluginSlug: "writing-bundle",
          sourceRepo: null,
          sourceMarketplaceRepo: null,
          pluginEnabled: true,
          scope: "org",
          clientType: "claude-code",
          supportedPlatforms: ["posix"],
          skillPath: "skills/writing",
          name: "Plugin writing instructions",
          description: "Instructions delivered by a plugin.",
          compatibility: null,
          fileCount: 1,
          usageCount: 0,
          usageUserCount: 0,
          lastUsedAt: null,
        },
      ],
    },
  ]);
  await page.goto("/skills?kind=plugin");
  await expect(
    page.getByRole("heading", { level: 1, name: "Skills" }),
  ).toBeVisible();
  await expect(
    page.getByText("Plugin writing instructions", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Writing bundle · Plugin" }),
  ).toHaveAttribute("href", "/plugins/11111111-1111-4111-8111-111111111111");
  await expect(
    page.getByRole("checkbox", { name: "Select Plugin writing instructions" }),
  ).toBeDisabled();
});
