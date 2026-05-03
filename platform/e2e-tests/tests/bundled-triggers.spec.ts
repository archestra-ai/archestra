import { expect, test } from "../fixtures";

test("bundled trigger tabs appear and open the shared bundled trigger page", async ({
  page,
  goToPage,
}) => {
  await goToPage(page, "/agents/triggers");

  const whatsappTab = page.locator('a[href="/agents/triggers/whatsapp"]');
  await expect(whatsappTab).toBeVisible();

  await whatsappTab.click();

  await expect(page).toHaveURL(/\/agents\/triggers\/whatsapp$/);
  await expect(page.getByTestId("bundled-trigger-card")).toBeVisible();
  await expect(page.getByTestId("bundled-trigger-start-button")).toBeVisible();
  await expect(
    page.getByText("Run the bundled WhatsApp ChatOps adapter process."),
  ).toBeVisible();
});
