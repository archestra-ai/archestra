import { DEFAULT_TEAM_NAME, MCP_SERVER_TOOL_NAME_SEPARATOR } from "../consts";
import { goToPage } from "../fixtures";
import {
  APP_SDK_JSON_SERVER_TASK_COUNT,
  APP_SDK_JSON_SERVER_TOOL_NAME,
  ensureAppSdkJsonTestServerCatalogItem,
  findInstalledServer,
  waitForServerInstallation,
} from "../utils";
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

// Two `hidden` elements, both with a display override. `#reset-hides` uses an
// ordinary rule the injected base sheet's `[hidden]` reset must still beat;
// `#stuck-visible` fights back with `!important` and stays painted — the footgun
// the SDK render lint is the backstop for. The lint must flag only the latter.
const HIDDEN_LINT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>e2e hidden lint probe</title>
<style>
  #reset-hides { display: flex; position: fixed; inset: 0; }
  #stuck-visible { display: flex !important; position: fixed; inset: 0; }
</style></head>
<body>
  <div id="reset-hides" hidden>the base reset must hide this</div>
  <div id="stuck-visible" hidden>stuck visible despite the hidden attribute</div>
  <p id="status">loading…</p>
  <script>
    window.archestra.ready.then(() => {
      document.getElementById("status").textContent = "Ready.";
    });
  </script>
</body>
</html>`;

test("the render lint flags a hidden element an app override left visible", async ({
  page,
  request,
  makeApiRequest,
}) => {
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

  // The SDK scans twice by design (at DOMContentLoaded and again after `ready`),
  // so the raw postMessage stream carries the same diagnostic more than once; the
  // host store dedups on type+message before it reaches the model. This probe
  // reads the raw stream, so dedup by message here to assert on the distinct
  // offender set the store would keep.
  const hiddenOverridden = () =>
    page.evaluate(() => {
      const seen = new Set<string>();
      return (
        window as unknown as {
          __appDiagnostics: { errorType?: string; message?: string }[];
        }
      ).__appDiagnostics.filter((d) => {
        if (d.errorType !== "render-check") return false;
        const message = d.message ?? "";
        if (!message.includes("[hidden-overridden]")) return false;
        if (seen.has(message)) return false;
        seen.add(message);
        return true;
      });
    });

  try {
    const patchRes = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/apps/${app.id}`,
      data: { html: HIDDEN_LINT_HTML },
    });
    expect(patchRes.ok()).toBeTruthy();

    await goToPage(page, `/a/${app.id}`);
    await expect(page).toHaveTitle(name);
    const appFrame = page.frameLocator("iframe").frameLocator("iframe");
    await expect(appFrame.getByText("Ready.")).toBeVisible({ timeout: 20_000 });

    // The lint runs a couple frames after the handshake, so poll until it forwards.
    await expect.poll(hiddenOverridden, { timeout: 10_000 }).not.toEqual([]);
    const lint = await hiddenOverridden();
    // Only the `!important` override is stuck visible; the reset-hidden element
    // must not be flagged.
    expect(lint).toHaveLength(1);
    expect(lint[0].message).toContain("stuck-visible");
    expect(lint[0].message).not.toContain("reset-hides");
  } finally {
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/apps/${app.id}`,
      ignoreStatusCheck: true,
    });
  }
});

// Probe for the `archestra.tools.call` unwrapping contract: the fixture tool
// returns `{"tasks":[...]}` serialized into content[0].text, so `call` must
// resolve with the parsed object (the probe reads `result.tasks.length`
// directly off the resolved value).
const buildToolsCallProbeHtml = (toolName: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>e2e tools.call probe</title></head>
<body>
  <h1>tools.call unwrap probe</h1>
  <p id="unwrapped">Calling…</p>
  <script>
    (async () => {
      const unwrapped = document.getElementById("unwrapped");
      const toolName = ${JSON.stringify(toolName)};
      try {
        const result = await window.archestra.tools.call(toolName, {});
        unwrapped.textContent = "unwrapped-tasks:" + result.tasks.length;
      } catch (err) {
        unwrapped.textContent =
          "call-failed: " + (err && err.message ? err.message : String(err));
      }
    })();
  </script>
</body>
</html>`;

test("app SDK tools.call unwraps a JSON-as-text tool result", async ({
  page,
  request,
  makeApiRequest,
  installMcpServer,
  uninstallMcpServer,
  getTeamByName,
}) => {
  // Installing the local fixture MCP server (npm install inside the pod)
  // dominates the runtime — same budget as the orchestrator local-server suite.
  test.setTimeout(240_000);

  const defaultTeam = await getTeamByName(request, DEFAULT_TEAM_NAME);
  if (!defaultTeam) {
    throw new Error("Default Team not found");
  }

  const catalogItem = await ensureAppSdkJsonTestServerCatalogItem(request);

  // A crashed earlier run can leave a broken install behind; reuse a healthy
  // one, replace anything else.
  let server = await findInstalledServer(
    request,
    catalogItem.id,
    defaultTeam.id,
  );
  if (server) {
    try {
      await waitForServerInstallation(request, server.id);
    } catch {
      await uninstallMcpServer(request, server.id);
      // Give K8s time to tear the deployment down before reinstalling.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      server = undefined;
    }
  }
  if (!server) {
    const installResponse = await installMcpServer(request, {
      name: catalogItem.name,
      catalogId: catalogItem.id,
      scope: "team",
      teamId: defaultTeam.id,
    });
    server = (await installResponse.json()) as {
      id: string;
      catalogId: string;
    };
  }
  const serverId = server.id;

  try {
    await waitForServerInstallation(request, serverId);

    // Tool discovery persists the tool rows; poll until the fixture tool shows
    // up so we get its id (for assignment) and full prefixed name (for the call).
    const expectedToolSuffix = `${MCP_SERVER_TOOL_NAME_SEPARATOR}${APP_SDK_JSON_SERVER_TOOL_NAME}`;
    let fixtureTool: { id: string; name: string } | undefined;
    await expect
      .poll(
        async () => {
          const toolsResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/mcp_server/${serverId}/tools`,
          });
          const tools = (await toolsResponse.json()) as Array<{
            id: string;
            name: string;
          }>;
          fixtureTool = tools.find((tool) =>
            tool.name.endsWith(expectedToolSuffix),
          );
          return fixtureTool !== undefined;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    if (!fixtureTool) {
      throw new Error(
        `Tool "*${expectedToolSuffix}" was not discovered on server ${serverId}`,
      );
    }

    const appName = `e2e-app-tools-${Date.now()}`;
    const createRes = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/apps",
      data: { name: appName, scope: "personal" },
    });
    const app = (await createRes.json()) as { id: string };

    try {
      // Dynamic credential resolution: the viewer's Default Team install is
      // picked at call time, so no server pin is needed on the assignment.
      const assignRes = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/apps/${app.id}/tools/${fixtureTool.id}`,
        data: { credentialResolutionMode: "dynamic" },
      });
      expect(assignRes.ok()).toBeTruthy();

      const patchRes = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: `/api/apps/${app.id}`,
        data: { html: buildToolsCallProbeHtml(fixtureTool.name) },
      });
      expect(patchRes.ok()).toBeTruthy();

      await goToPage(page, `/a/${app.id}`);
      const appFrame = page.frameLocator("iframe").frameLocator("iframe");
      await expect(
        appFrame.getByText(`unwrapped-tasks:${APP_SDK_JSON_SERVER_TASK_COUNT}`),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/apps/${app.id}`,
        ignoreStatusCheck: true,
      });
    }
  } finally {
    await uninstallMcpServer(request, serverId);
  }
});
