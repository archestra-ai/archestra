import { expect, test } from "./fixtures";

test.describe("MCP Registry (mocked backend)", () => {
  test("lists catalog items and opens the edit form when one is clicked", async ({
    mcpRegistryPage,
    page,
  }) => {
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    const filesystemCard = mcpRegistryPage.cardForCatalogItem("filesystem");
    const githubCard = mcpRegistryPage.cardForCatalogItem("github");
    await expect(filesystemCard).toBeVisible();
    await expect(githubCard).toBeVisible();
    await expect(filesystemCard).toContainText(
      "Read and write files on the local filesystem.",
    );

    await mcpRegistryPage.settingsButtonFor("filesystem").click();

    // The settings dialog uses an sr-only DialogTitle of "<name> Settings"
    // which provides the accessible name Playwright reads.
    const dialog = page.getByRole("dialog", { name: /filesystem Settings/i });
    await expect(dialog).toBeVisible();

    // EditCatalogContent renders McpCatalogForm with mode="edit" and
    // nameDisabled — the Name input is populated with the catalog item's
    // name and rendered read-only. The form's FormLabel is not linked to the
    // input via htmlFor, so the placeholder is the most stable hook here.
    const nameInput = dialog.getByPlaceholder("e.g., GitHub MCP Server");
    await expect(nameInput).toHaveValue("filesystem");
    await expect(nameInput).toBeDisabled();
  });

  test("renders no cards when catalog and servers are overridden to empty", async ({
    mcpRegistryPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [],
    });
    await mswControl.use({
      method: "get",
      url: "/api/mcp_server",
      body: [],
    });

    await mcpRegistryPage.goto();

    await expect(mcpRegistryPage.heading).toBeVisible();
    await expect(mcpRegistryPage.serverCards).toHaveCount(0);
  });

  test("overrides propagate to the browser MSW worker, not just SSR", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    const sentinel = [
      { id: "browser-sentinel", name: "browser-propagation-marker" },
    ];
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: sentinel,
    });

    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    // Direct browser-side fetch — bypasses SSR data and exercises the
    // setupWorker handlers exclusively. If overrides only reached the Node
    // server, this would fall through to the base handler (2 catalog items).
    const browserResponse = await page.evaluate(async () => {
      const res = await fetch("/api/internal_mcp_catalog");
      return res.json();
    });
    expect(browserResponse).toEqual(sentinel);
  });

  test("repeated overrides for the same endpoint — browser sees the latest", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [{ id: "first", name: "first" }],
    });
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [{ id: "second", name: "second" }],
    });

    // Node and browser handler chains must agree on which override wins.
    // The browser sync replays the registry one entry at a time so that
    // repeated POSTs of the same method+url stack in latest-first order
    // exactly like the Node-side `server.use(...)` calls do.
    const browserResult = await page.evaluate(async () => {
      const res = await fetch("/api/internal_mcp_catalog");
      return res.json();
    });
    expect(browserResult).toEqual([{ id: "second", name: "second" }]);
  });

  test("overrides registered AFTER navigation reach the browser worker", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    // Navigate first — MswInit completes its initial registry replay before
    // any override exists. The override below is "late": registered after
    // the page has mounted.
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    // Confirm the baseline is in effect at this point.
    const baseline = await page.evaluate(async () => {
      const res = await fetch("/api/internal_mcp_catalog");
      return res.json();
    });
    expect(baseline).toHaveLength(2);

    // Late override.
    const sentinel = [{ id: "late-marker", name: "late-marker" }];
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: sentinel,
    });

    // Without live propagation the browser would still return the baseline
    // here — the worker only ran an initial registry replay at startup.
    const overridden = await page.evaluate(async () => {
      const res = await fetch("/api/internal_mcp_catalog");
      return res.json();
    });
    expect(overridden).toEqual(sentinel);
  });
});
