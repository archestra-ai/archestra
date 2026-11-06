import { makeUserPermissions } from "../src/mocks/data/auth";
import { expect, test } from "./fixtures";

test("runtime notice stacks its action and opens diagnostics on mobile", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/user/permissions",
    body: makeUserPermissions({
      agent: ["read", "create", "update", "delete", "configure-runtime"],
    }),
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/agents/new");

  const notice = page.getByRole("alert").filter({
    hasText: "Some agent options are unavailable.",
  });
  const message = notice.getByText(
    "The Agent Sandbox controller is not installed.",
    { exact: true },
  );
  const install = notice.getByRole("link", { name: "Install controller" });
  const diagnostics = notice.getByText(/Missing API resources:/);
  const toggle = notice.getByRole("button", { name: "Show details" });

  await expect(install).toBeVisible();
  await expect(diagnostics).toBeVisible();
  await expect(toggle).toBeHidden();
  const messageBounds = await message.boundingBox();
  const installBounds = await install.boundingBox();
  expect(messageBounds).not.toBeNull();
  expect(installBounds).not.toBeNull();
  if (messageBounds && installBounds) {
    expect(installBounds.y).toBeGreaterThanOrEqual(
      messageBounds.y + messageBounds.height,
    );
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(toggle).toBeVisible();
  await expect(diagnostics).toBeHidden();
  await toggle.click();
  await expect(diagnostics).toBeVisible();
  await notice.getByRole("button", { name: "Hide details" }).click();
  await expect(diagnostics).toBeHidden();
});
