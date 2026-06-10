import { goToPage } from "../fixtures";
import { expect, test } from "./api-fixtures";

// Seed an app from the `form` template (resolved server-side from templateId),
// open /apps/:id/run, and assert through the nested sandbox frames
// (host page → sandbox proxy iframe → inner app iframe) that the form reaches
// "Ready." — which the template only shows after the injected runtime bridge
// connected the guest SDK and completed a data-store read round-trip. This is
// the end-to-end proof of the serve-time bridge injection in a real browser.
test("create an app from a template and run it standalone", async ({
  page,
  request,
  makeApiRequest,
}) => {
  const name = `e2e-app-${Date.now()}`;
  const createRes = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/apps",
    data: { name, scope: "personal", templateId: "form" },
  });
  const app = (await createRes.json()) as { id: string };

  try {
    await goToPage(page, `/apps/${app.id}/run`);
    await expect(page.getByText(name)).toBeVisible();

    const proxyFrame = page.frameLocator("iframe");
    const appFrame = proxyFrame.frameLocator("iframe");
    await expect(appFrame.getByText("Ready.")).toBeVisible({
      timeout: 20_000,
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
