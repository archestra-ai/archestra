import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { expect, test } from "./fixtures";

let attachmentServer: Server;
let installerUrl: string;
let bundle: Buffer;
let downloads: number;

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeAll(async () => {
  // Exercise a browser attachment download, with a credential-free MCPB
  // fixture. The backend bundle/route tests cover native installer contents
  // and ticket redemption; this suite covers delivery of the returned bytes.
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({ name: "desktop-download-fixture" }),
  );
  zip.file("setup.json", JSON.stringify({ rawToken: "test-render-ticket" }));
  bundle = await zip.generateAsync({ type: "nodebuffer" });
  attachmentServer = createServer((_request, response) => {
    downloads++;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        'attachment; filename="Connect-Claude-Desktop.mcpb"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bundle);
  });
  await new Promise<void>((resolve) =>
    attachmentServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (attachmentServer.address() as AddressInfo).port;
  installerUrl = `http://127.0.0.1:${port}/Connect-Claude-Desktop.mcpb`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    attachmentServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(async ({ mswControl }) => {
  downloads = 0;
  await mswControl.use({
    method: "post",
    url: "/api/connection-setups",
    delayMs: 1500,
    body: {
      id: "desktop-download-setup",
      command: "echo desktop-download-fixture",
      installerUrl,
      tokenStart: "test-render",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      plugins: [],
    },
  });
});

test("one click prepares and downloads once; the ready link downloads the same artifact again", async ({
  page,
}, testInfo) => {
  const preparations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/connection-setups"
    )
      preparations.push(request.postData() ?? "");
  });
  await page.goto("/connection?clientId=claude-desktop");
  const downloadButton = page.getByRole("button", {
    name: "Download installer",
    exact: true,
  });
  await expect(downloadButton).toBeVisible();
  expect(preparations).toHaveLength(0);
  expect(downloads).toBe(0);

  const firstDownload = page.waitForEvent("download");
  await downloadButton.dblclick();
  await expect(
    page.getByRole("button", { name: "Preparing installer", exact: true }),
  ).toBeDisabled();
  await testInfo.attach("preparing-installer", {
    body: await page.screenshot({
      path: testInfo.outputPath("preparing-installer.png"),
    }),
    contentType: "image/png",
  });
  const first = await firstDownload;
  expect(first.suggestedFilename()).toBe("Connect-Claude-Desktop.mcpb");
  const path = await first.path();
  if (!path) throw new Error("Installer download has no file");
  expect(await readFile(path)).toEqual(bundle);
  const zip = await JSZip.loadAsync(await readFile(path));
  const setup = zip.file("setup.json");
  if (!setup) throw new Error("Downloaded installer has no setup ticket");
  expect(JSON.parse(await setup.async("string"))).toEqual({
    rawToken: "test-render-ticket",
  });

  const link = page.getByRole("link", {
    name: "Download installer",
    exact: true,
  });
  await expect(link).toHaveAttribute("href", installerUrl);
  expect(preparations).toHaveLength(1);
  expect(downloads).toBe(1);
  const repeatDownload = page.waitForEvent("download");
  await link.click();
  expect((await repeatDownload).suggestedFilename()).toBe(
    "Connect-Claude-Desktop.mcpb",
  );
  expect(preparations).toHaveLength(1);
  expect(downloads).toBe(2);
  await testInfo.attach("installer-downloaded", {
    body: await page.screenshot({
      path: testInfo.outputPath("installer-downloaded.png"),
    }),
    contentType: "image/png",
  });
});

test("a failed preparation offers one-click retry and disables repeated retry clicks while loading", async ({
  page,
  mswControl,
}, testInfo) => {
  await mswControl.use({
    method: "post",
    url: "/api/connection-setups",
    status: 500,
    once: true,
    body: {
      error: {
        message: "Installer temporarily unavailable",
        type: "api_error",
      },
    },
  });
  let preparations = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/connection-setups"
    )
      preparations++;
  });
  await page.goto("/connection?clientId=claude-desktop");
  await page
    .getByRole("button", { name: "Download installer", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Could not prepare the installer" }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await testInfo.attach("preparation-error", {
    body: await page.screenshot({
      path: testInfo.outputPath("preparation-error.png"),
    }),
    contentType: "image/png",
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Try again", exact: true }).dblclick();
  await expect(
    page.getByRole("button", { name: "Preparing installer", exact: true }),
  ).toBeDisabled();
  expect((await download).suggestedFilename()).toBe(
    "Connect-Claude-Desktop.mcpb",
  );
  expect(preparations).toBe(2);
  expect(downloads).toBe(1);
  await expect(
    page.getByRole("link", { name: "Download installer", exact: true }),
  ).toBeVisible();
});
