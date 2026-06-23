import { E2eTestId } from "@archestra/shared";
import type { APIRequestContext } from "@playwright/test";
import { goToPage } from "../fixtures";
import { expect, type TestFixtures, test } from "./api-fixtures";

// Seed a personal app from the default template, run the body, then delete it.
async function withApp(
  makeApiRequest: TestFixtures["makeApiRequest"],
  request: APIRequestContext,
  run: (app: { id: string; name: string }) => Promise<void>,
) {
  const name = `e2e-app-${Date.now()}`;
  const res = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/apps",
    data: { name, scope: "personal" },
  });
  const { id } = (await res.json()) as { id: string };
  try {
    await run({ id, name });
  } finally {
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/apps/${id}`,
      ignoreStatusCheck: true,
    });
  }
}

// Open /a/:id (the full-page runtime) and assert through the nested sandbox
// frames (host page → sandbox proxy iframe → inner app iframe) that the app
// reaches "Ready." — which the template only shows after the injected runtime
// bridge connected the guest SDK and completed a data-store read round-trip.
// The runtime owns its chrome, so the app name is the tab title and the global
// sidebar must not render.
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

  await withApp(makeApiRequest, request, async ({ id, name }) => {
    await goToPage(page, `/a/${id}`);

    await expect(page).toHaveTitle(name);
    await expect(page.getByTestId(E2eTestId.SidebarUserProfile)).toHaveCount(0);

    const proxyFrame = page.frameLocator("iframe");
    const appFrame = proxyFrame.frameLocator("iframe");
    await expect(appFrame.getByText("Ready.")).toBeVisible({ timeout: 20_000 });
    // auto-auth: the SDK bootstrap carries the viewer identity and the default
    // template personalizes its heading from archestra.user.name
    await expect(
      appFrame.getByRole("heading", { name: /^Hello, / }),
    ).toBeVisible();

    const diagnostics = await page.evaluate(
      () =>
        (window as unknown as { __appDiagnostics: unknown[] }).__appDiagnostics,
    );
    expect(diagnostics).toEqual([]);
  });
});

// The management page (/apps/:id) is a normal app-shell page: sidebar plus the
// management tabs.
test("app management page keeps the sidebar and shows the tabs", async ({
  page,
  request,
  makeApiRequest,
}) => {
  await withApp(makeApiRequest, request, async ({ id }) => {
    await goToPage(page, `/apps/${id}`);

    await expect(page.getByTestId(E2eTestId.SidebarUserProfile)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Preview" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible();
  });
});
