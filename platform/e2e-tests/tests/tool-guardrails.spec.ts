/**
 * Guardrails source labelling.
 *
 * An app's launch tool is catalog-backed (its catalog is the app's backing,
 * `serverType: "app"`), but app backings are kept out of the registry listing —
 * so the guardrails table could not resolve their catalog and fell through to
 * the "Observed tools" badge. That badge contradicted the source filter, which
 * correctly returned nothing for those rows because they are not proxy-observed
 * tools. These tests pin both halves: the row names its app, and the observed
 * filter still excludes it.
 */
import { goToPage } from "../fixtures";
import { expect, test } from "./api-fixtures";

test("labels an app's launch tool with its app, not as observed traffic", async ({
  page,
  request,
  makeApiRequest,
}) => {
  const name = `e2e-guardrails-app-${Date.now()}`;
  const createRes = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/apps",
    data: { name, scope: "personal" },
  });
  const app = (await createRes.json()) as { id: string };

  try {
    // The App source lists the launch tool, badged with the app's name.
    await goToPage(
      page,
      `/mcp/tool-guardrails?origin=app&search=${encodeURIComponent(name)}`,
    );
    const appRow = page.getByRole("row").filter({ hasText: name });
    await expect(appRow).toHaveCount(1);
    await expect(appRow).not.toContainText("Observed tools");

    // Its details dialog agrees: origin App, never "Intercepted".
    await appRow.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("App", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Intercepted")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Observed tools are the ones seen in agent-provider traffic — a launch
    // tool comes from a catalog, so it must not be listed there.
    await goToPage(
      page,
      `/mcp/tool-guardrails?origin=llm-proxy&search=${encodeURIComponent(name)}`,
    );
    await expect(
      page.locator("table tbody tr").filter({ hasText: name }),
    ).toHaveCount(0);
  } finally {
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/apps/${app.id}`,
      ignoreStatusCheck: true,
    });
  }
});
