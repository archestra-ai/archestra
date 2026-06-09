import { goToPage } from "../fixtures";
import { expect, test } from "./api-fixtures";

// Standalone-first: seed an app from the `form` template via the API, then open
// /apps/:id/run and assert the sandboxed runtime mounts. The data-store
// round-trip itself runs cross-origin inside the sandbox iframe and is covered
// by the backend app_data tests + the template wiring test; here we prove the
// route, feature flag, and runtime mount end-to-end.
test("create an app and open its standalone run page", async ({
  page,
  request,
  makeApiRequest,
}) => {
  const templatesRes = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/app-templates",
  });
  const templates = (await templatesRes.json()) as Array<{
    id: string;
    html: string;
  }>;
  const form = templates.find((t) => t.id === "form");
  expect(form).toBeTruthy();

  const name = `e2e-app-${Date.now()}`;
  const createRes = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/apps",
    data: { name, html: form?.html, scope: "personal", templateId: "form" },
  });
  const app = (await createRes.json()) as { id: string };

  try {
    await goToPage(page, `/apps/${app.id}/run`);
    await expect(page.getByText(name)).toBeVisible();
    // The runtime creates the sandbox proxy iframe once the resource loads.
    await expect(page.locator("iframe").first()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/apps/${app.id}`,
      ignoreStatusCheck: true,
    });
  }
});
