import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

const settingName = "Allow requests without a virtual key";

test("virtual-key setting can be cancelled and saved above the providers", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "patch",
    url: "/api/organization/security-settings",
    body: makeOrganization({ allowUnauthenticatedLlmProxyRequests: true }),
  });
  await page.goto("/settings/llm");
  const toggle = page.getByRole("switch", { name: settingName });
  await expect(toggle).not.toBeChecked();
  const setting = page.getByRole("heading", { name: settingName });
  const providers = page.getByRole("heading", { name: "Model providers" });
  await expect(setting).toBeVisible();
  await expect(providers).toBeVisible();
  expect((await setting.boundingBox())?.y).toBeLessThan(
    (await providers.boundingBox())?.y ?? 0,
  );
  const warning = page.getByRole("alert").filter({ hasText: "Dangerous" });
  await expect(warning).toContainText(
    "per-user limits and attribution don't apply",
  );
  const description = page.getByText(
    "Accept LLM proxy requests that carry only a provider key, or none.",
    { exact: true },
  );
  expect((await setting.boundingBox())?.y).toBeLessThan(
    (await warning.boundingBox())?.y ?? 0,
  );
  expect((await warning.boundingBox())?.y).toBeLessThan(
    (await description.boundingBox())?.y ?? 0,
  );
  await expect(toggle).toHaveAccessibleDescription(
    "Accept LLM proxy requests that carry only a provider key, or none.",
  );
  await expect(page.getByText("Next step:")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Set up the LLM proxy" }),
  ).toBeHidden();

  await toggle.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/organization/security-settings") &&
      request.method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).postDataJSON()).toEqual({
    allowUnauthenticatedLlmProxyRequests: true,
  });
  await expect(
    page.getByText("LLM proxy settings updated", { exact: true }),
  ).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeHidden();
  await expect(warning).toBeVisible();
});

test("read-only users see the warning with the setting disabled", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/user/permissions",
    body: makeUserPermissions({ organizationSettings: ["read"] }),
  });
  await page.goto("/settings/llm");
  await expect(page.getByRole("switch", { name: settingName })).toBeDisabled();
  await expect(
    page.getByRole("alert").filter({ hasText: "Dangerous" }),
  ).toBeVisible();
});

test("mobile keeps the warning and switch readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/llm");
  const toggle = page.getByRole("switch", { name: settingName });
  await expect(toggle).toBeVisible();
  const warning = page.getByRole("alert").filter({ hasText: "Dangerous" });
  await expect(warning).toBeVisible();
  const bounds = await warning.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  const descriptionBounds = await page
    .getByText(
      "Accept LLM proxy requests that carry only a provider key, or none.",
      {
        exact: true,
      },
    )
    .boundingBox();
  const toggleBounds = await toggle.boundingBox();
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
    descriptionBounds?.y ?? 0,
  );
  expect(toggleBounds?.y).toBeGreaterThanOrEqual(descriptionBounds?.y ?? 0);
  expect(
    (toggleBounds?.y ?? 0) + (toggleBounds?.height ?? 0),
  ).toBeLessThanOrEqual(
    (descriptionBounds?.y ?? 0) + (descriptionBounds?.height ?? 0),
  );
  await toggle.click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).not.toBeChecked();
});
