import { goToPage } from "../fixtures";
import { expect, test } from "./api-fixtures";

// Seed an app, publish a minimal SDK-probe version, open /a/:id, and assert
// through the nested sandbox frames (host page → sandbox proxy iframe → inner
// app iframe) that the app reaches "Ready." — which the probe only shows after
// the injected runtime bridge connected the guest SDK and completed a
// data-store read round-trip. This is the end-to-end proof of the serve-time
// bridge injection in a real browser. (The default template used to carry this
// probe itself; since #6019 it is a pure-UI empty state with no SDK calls, so
// the test publishes its own probe html.)
const SDK_PROBE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>e2e SDK probe</title></head>
<body>
  <h1 id="greeting">Connecting…</h1>
  <p id="status">Waiting for the runtime bridge…</p>
  <script>
    (async () => {
      const greeting = document.getElementById("greeting");
      const status = document.getElementById("status");
      try {
        if (window.archestra && window.archestra.user && window.archestra.user.name) {
          greeting.textContent = "Hello, " + window.archestra.user.name;
        }
        await window.archestra.storage.user.get("e2e-probe");
        status.textContent = "Ready.";
      } catch (err) {
        status.textContent = "Bridge failed: " + (err && err.message ? err.message : String(err));
      }
    })();
  </script>
</body>
</html>`;

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
    data: { name, scope: "personal" },
  });
  const app = (await createRes.json()) as { id: string };

  try {
    // Publish the SDK probe as the app's html (forks a new version).
    const patchRes = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/apps/${app.id}`,
      data: { html: SDK_PROBE_HTML },
    });
    expect(patchRes.ok()).toBeTruthy();

    await goToPage(page, `/a/${app.id}`);
    // The standalone runtime is chromeless: the app name is the browser tab
    // title, not on-page text.
    await expect(page).toHaveTitle(name);

    const proxyFrame = page.frameLocator("iframe");
    const appFrame = proxyFrame.frameLocator("iframe");
    await expect(appFrame.getByText("Ready.")).toBeVisible({
      timeout: 20_000,
    });
    // auto-auth: the SDK bootstrap carries the viewer identity and the probe
    // personalizes its heading from archestra.user.name
    await expect(
      appFrame.getByRole("heading", { name: /^Hello, / }),
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
