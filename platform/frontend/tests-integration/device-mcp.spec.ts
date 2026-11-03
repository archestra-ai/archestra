import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

const catalogId = "d769a42b-61e5-4f44-b113-1a5b5e65ac43";
const config = {
  protocolVersion: 1 as const,
  version: "1.0.0",
  platforms: {
    darwin: { command: "node", args: ["fixture.mjs"] },
    win32: { command: "node", args: ["fixture.mjs"] },
  },
  tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
};

test("MCP settings show accessible opt-in switches at desktop and mobile widths", async ({
  page,
  mswControl,
  request,
}, testInfo) => {
  const organization = makeOrganization();
  const configResponse = await request.get("/internal-test/api/api/config");
  expect(configResponse.ok()).toBe(true);
  const seedConfig = await configResponse.json();
  await mswControl.registerMany([
    { method: "get", url: "/api/organization", body: organization },
    {
      method: "get",
      url: "/api/config",
      body: {
        ...seedConfig,
        enterpriseFeatures: { ...seedConfig.enterpriseFeatures, core: true },
        features: {
          ...seedConfig.features,
          mcpIdleHibernationBetaEnabled: true,
        },
      },
    },
  ]);
  await page.goto("/settings/mcp");
  const device = page.getByRole("switch", {
    name: "Device MCP servers",
    exact: true,
  });
  await expect(device).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Online MCP catalog", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Idle hibernation", exact: true }),
  ).not.toBeChecked();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await device.scrollIntoViewIfNeeded();
    await expect(device).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`device-settings-${width}.png`),
      fullPage: true,
    });
  }
  await device.focus();
  await page.keyboard.press("Space");
  await expect(device).toBeChecked();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(device).not.toBeChecked();
});

test("device registry setup guides pairing and explicit offline replacement without shared installation", async ({
  page,
  mswControl,
}, testInfo) => {
  const catalog = makeCatalogItem({
    id: catalogId,
    name: "Device Echo",
    serverType: "device",
    deviceConfig: config,
  });
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/organization",
      body: makeOrganization({ deviceMcpEnabled: true }),
    },
    { method: "get", url: "/api/internal_mcp_catalog", body: [catalog] },
    { method: "get", url: "/api/mcp_server", body: [] },
    { method: "get", url: "/api/device-mcp", body: [] },
    {
      method: "post",
      url: "/api/device-mcp/pair",
      body: {
        code: "fictional-one-time-pairing-code",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        config,
        configDigest: "f".repeat(64),
      },
    },
  ]);
  await page.goto(`/mcp/registry/${catalogId}`);
  await expect(
    page.getByText("Your device connection", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Device name", { exact: true }).fill("My test laptop");
  const pairRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/device-mcp/pair"),
  );
  await page
    .getByRole("button", { name: "Prepare device setup", exact: true })
    .click();
  expect((await pairRequest).postDataJSON()).toEqual({
    catalogId,
    name: "My test laptop",
    replaceExisting: false,
  });
  await expect(
    page.getByRole("heading", { name: "Finish setup on your device" }),
  ).toBeVisible();
  await page
    .getByRole("tab", { name: "Windows PowerShell", exact: true })
    .click();
  await expect(page.getByText(/--code 'PAIRING_CODE'/)).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .getByText("Your device connection", { exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`device-setup-${width}.png`),
      fullPage: true,
    });
  }
  await mswControl.use({
    method: "get",
    url: "/api/device-mcp",
    body: [
      {
        id: "e769a42b-61e5-4f44-b113-1a5b5e65ac43",
        name: "My test laptop",
        status: "offline",
        configVersion: "1.0.0",
        lastSeenAt: null,
      },
    ],
  });
  await expect(
    page.getByText("Your device is offline", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare device setup", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "Replace my selected device and disconnect its existing connector",
    })
    .check();
  await expect(
    page.getByRole("button", { name: "Prepare device setup", exact: true }),
  ).toBeEnabled();
});
