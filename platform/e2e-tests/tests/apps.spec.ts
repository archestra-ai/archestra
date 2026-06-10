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
  // a clean render must forward NO diagnostics to the host — platform noise
  // (e.g. the guest SDK's caught new Function("") CSP probe) once flagged
  // every app with a spurious "1 runtime error" badge
  await page.addInitScript(() => {
    const w = window as unknown as { __appDiagnostics: unknown[] };
    w.__appDiagnostics = [];
    window.addEventListener("message", (event) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (
        type === "mcp-apps:runtime-error" ||
        type === "mcp-apps:csp-violation"
      ) {
        w.__appDiagnostics.push(event.data);
      }
    });
  });

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
    // auto-auth: the SDK bootstrap carries the viewer identity and the form
    // template personalizes its title from archestra.user.name
    await expect(
      appFrame.getByRole("heading", { name: /'s notes$/ }),
    ).toBeVisible();

    const diagnostics = await page.evaluate(
      () =>
        (window as unknown as { __appDiagnostics: unknown[] }).__appDiagnostics,
    );
    expect(diagnostics).toEqual([]);
  } finally {
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/apps/${app.id}`,
      ignoreStatusCheck: true,
    });
  }
});
