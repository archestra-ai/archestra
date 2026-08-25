import { expect } from "@playwright/test";
import { test } from "../fixtures";

/**
 * Evals (beta): suite + case CRUD through the UI. Run execution itself is
 * covered by backend handler/route tests — executing here would couple the
 * spec to worker timing and live LLM stubs.
 */
test("create an eval suite, manage cases, and reach the run dialog", async ({
  page,
  goToPage,
  makeRandomString,
}) => {
  const suiteName = `E2E Suite ${makeRandomString(6)}`;

  await goToPage(page, "/evals");
  await expect(
    page.getByRole("heading", { name: /Evals/i }).first(),
  ).toBeVisible();

  // Create a suite.
  await page
    .getByRole("button", { name: /New suite/i })
    .first()
    .click();
  await page.getByLabel(/Name/i).fill(suiteName);
  await page
    .getByLabel(/Description/i)
    .fill("Created by the e2e suite CRUD spec");
  await page.getByRole("button", { name: /^Create$/i }).click();

  // Creation navigates to the suite detail page.
  await expect(page.getByRole("heading", { name: suiteName })).toBeVisible();
  await expect(page.getByText("No cases yet")).toBeVisible();

  // Run is disabled while the suite has no cases.
  await expect(page.getByRole("button", { name: /^Run$/i })).toBeDisabled();

  // Add a case with a contains assertion (the dialog's default type).
  await page.getByRole("button", { name: /Add case/i }).click();
  const caseDialog = page.getByRole("dialog");
  await caseDialog.getByLabel(/Name/i).fill("Greeting");
  await caseDialog.getByLabel(/Input/i).fill("Say hello");
  await caseDialog
    .getByPlaceholder(/Values \(comma-separated\)/i)
    .fill("hello");
  await caseDialog.getByRole("button", { name: /Add case/i }).click();

  // The case lands in the table with its assertion chip.
  await expect(page.getByRole("cell", { name: "Greeting" })).toBeVisible();
  await expect(page.getByText("contains").first()).toBeVisible();

  // Run dialog opens now that a case exists.
  await page.getByRole("button", { name: /^Run$/i }).click();
  const runDialog = page.getByRole("dialog");
  await expect(
    runDialog.getByRole("heading", { name: /Run eval suite/i }),
  ).toBeVisible();
  // Starting is gated on picking an agent.
  await expect(
    runDialog.getByRole("button", { name: /Start run/i }),
  ).toBeDisabled();
  await runDialog.getByRole("button", { name: /Cancel/i }).click();

  // Edit the case.
  await page
    .getByRole("row", { name: /Greeting/ })
    .getByRole("button", { name: /Edit/i })
    .click();
  const editDialog = page.getByRole("dialog");
  await editDialog.getByLabel(/Name/i).fill("Greeting v2");
  await editDialog.getByRole("button", { name: /Save case/i }).click();
  await expect(page.getByRole("cell", { name: "Greeting v2" })).toBeVisible();

  // Delete the suite from the list page.
  await goToPage(page, "/evals");
  const suiteRow = page.getByRole("row", { name: new RegExp(suiteName) });
  await expect(suiteRow).toBeVisible();
  await suiteRow.getByRole("button", { name: /Delete/i }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Delete$/i })
    .click();
  await expect(suiteRow).not.toBeVisible();
});
