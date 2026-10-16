import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { expect, test } from "./fixtures";

test("keeps agent actions reachable after instructions load at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/agents/new");
  const name = page.getByRole("textbox", { name: /^Name\b/ });
  const fromScratch = page.getByRole("button", { name: /^New .* agent/ });
  await expect(name.or(fromScratch)).toBeVisible();
  if (!(await name.isVisible())) await fromScratch.click();
  await expect(name).toBeVisible();

  // The fixture's long default instructions grow the real editor from
  // its 200px loading placeholder to the 560px ceiling. Exercise the
  // loaded form, rather than passing against a transient loading layout.
  await expect(
    page.getByRole("textbox", { name: "Instructions", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "Resize instructions" }),
  ).toHaveAttribute("aria-valuenow", "560");

  const next = page.getByTestId(E2eTestId.AgentSetupNextButton);
  await expect(next).toBeDisabled();
  await next.scrollIntoViewIfNeeded();
  await expect(next).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByTestId(E2eTestId.AgentSetupSubmitButton),
  ).toBeInViewport({ ratio: 1 });
  await expect(name).toBeEmpty();
});
