import { E2eTestId, getE2eRequestUrl, UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import { goToMcpRegistry, submitAddServer } from "../utils";

/**
 * Cloning a catalog item via the registry "Clone" action must carry over its
 * stored secrets. The clone form is seeded from the list endpoint (which masks
 * secret values), so the value is never re-sent — the backend copies it.
 */
test.describe("MCP Catalog clone", () => {
  test("clone carries over the source's stored secret", async ({
    adminPage,
    makeRandomString,
    request,
  }) => {
    const sourceName = makeRandomString(6, "clone-src");
    const cloneName = `${sourceName}-copy`;
    const secretValue = "e2e-clone-secret-value";

    // Source created via API with a static (non-prompted) secret env var.
    const createResponse = await request.post(
      getE2eRequestUrl("/api/internal_mcp_catalog"),
      {
        headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
        data: {
          name: sourceName,
          description: "clone secret carry-over e2e",
          serverType: "local",
          scope: "org",
          localConfig: {
            command: "sh",
            arguments: ["-c", "true"],
            transportType: "stdio",
            environment: [
              {
                key: "CLONE_SECRET",
                type: "secret",
                value: secretValue,
                promptOnInstallation: false,
              },
            ],
          },
        },
      },
    );
    expect(createResponse.ok()).toBeTruthy();
    const source = await createResponse.json();
    expect(source.localConfigSecretId).toBeTruthy();

    try {
      await goToMcpRegistry(adminPage);

      await adminPage
        .getByTestId(`${E2eTestId.McpServerSettingsButton}-${sourceName}`)
        .click();

      const settingsDialog = adminPage.getByRole("dialog", {
        name: new RegExp(`${sourceName} Settings`, "i"),
      });
      await expect(settingsDialog).toBeVisible({ timeout: 30_000 });
      await settingsDialog
        .getByRole("button", { name: "Clone", exact: true })
        .click();

      const cloneDialog = adminPage.getByRole("dialog", {
        name: /Add MCP Server to the Private Registry/i,
      });
      await expect(cloneDialog).toBeVisible({ timeout: 30_000 });
      // Clone form is pre-filled (name becomes `<source>-copy`); submit as-is.
      await submitAddServer(adminPage);

      let cloneId = "";
      await expect
        .poll(
          async () => {
            const listResponse = await request.get(
              getE2eRequestUrl(
                "/api/internal_mcp_catalog?includeChildren=true",
              ),
              { headers: { Origin: UI_BASE_URL } },
            );
            const body = await listResponse.json();
            const items: Array<{ id: string; name: string }> = Array.isArray(
              body,
            )
              ? body
              : body.data;
            const found = items.find((item) => item.name === cloneName);
            if (found) cloneId = found.id;
            return Boolean(found);
          },
          { timeout: 30_000, intervals: [250, 500, 1000] },
        )
        .toBe(true);

      // GET expands secrets: the clone resolves the source's value, stored in
      // its own independent secret row (distinct id).
      const cloneResponse = await request.get(
        getE2eRequestUrl(`/api/internal_mcp_catalog/${cloneId}`),
        { headers: { Origin: UI_BASE_URL } },
      );
      const clone = await cloneResponse.json();
      expect(clone.localConfigSecretId).toBeTruthy();
      expect(clone.localConfigSecretId).not.toBe(source.localConfigSecretId);
      const envVar = clone.localConfig.environment.find(
        (entry: { key: string }) => entry.key === "CLONE_SECRET",
      );
      expect(envVar?.value).toBe(secretValue);

      await request.delete(
        getE2eRequestUrl(`/api/internal_mcp_catalog/${cloneId}`),
        { headers: { Origin: UI_BASE_URL } },
      );
    } finally {
      await request.delete(
        getE2eRequestUrl(`/api/internal_mcp_catalog/${source.id}`),
        { headers: { Origin: UI_BASE_URL } },
      );
    }
  });
});
