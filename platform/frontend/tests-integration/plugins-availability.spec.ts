import { expect, test } from "./fixtures";

test("plugins navigation and authoring ignore the plugins feature flag", async ({
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
        features: { ...config.features, plugins: false },
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
  await page.getByRole("link", { name: "Create a plugin", exact: true }).click();
  await expect(page).toHaveURL(/\/plugins\/new\?source=blank$/);
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Plugins are disabled for this deployment."),
  ).toHaveCount(0);
});

test("Skills shows plugin-backed instructions whatever the plugins feature flag", async ({
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
        features: { ...config.features, plugins: false },
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
