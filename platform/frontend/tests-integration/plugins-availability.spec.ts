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
