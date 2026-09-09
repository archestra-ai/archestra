import { createServer } from "node:http";
import { vi } from "vitest";
import { afterEach, beforeEach, expect, test } from "@/test";
import { WebCrawlerConnector } from "./web-crawler-connector";

// Chromium is an external subprocess. Exercise the real crawler and HTML
// extraction while controlling the browser's rendered response at that boundary.
const browser = vi.hoisted(() => ({
  close: vi.fn(),
  goto: vi.fn(),
  content: vi.fn(),
  url: vi.fn(),
}));
vi.mock("playwright-core", () => ({
  chromium: {
    launch: async () => ({
      close: browser.close,
      newContext: async () => ({
        routeWebSocket: async () => {},
        route: async () => {},
        newPage: async () => ({
          goto: browser.goto,
          content: browser.content,
          url: browser.url,
        }),
      }),
    }),
  },
}));
let closeServer: () => Promise<void>;
let startUrl: string;
beforeEach(async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><main></main></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server failed to bind");
  startUrl = `http://127.0.0.1:${address.port}/`;
  closeServer = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  browser.url.mockReturnValue(startUrl);
  browser.goto.mockResolvedValue({ ok: () => true });
  browser.content.mockResolvedValue(
    "<html><title>Rendered report</title><main>Content produced by JavaScript</main></html>",
  );
  browser.close.mockResolvedValue(undefined);
});
afterEach(async () => {
  await closeServer();
});

async function crawl(renderJavaScript: boolean) {
  const batches = [];
  for await (const batch of new WebCrawlerConnector().sync({
    config: {
      startUrl,
      renderJavaScript,
      renderWaitMs: 0,
      allowPrivateNetwork: true,
      maxDepth: 0,
    },
    credentials: { apiToken: "" },
    checkpoint: null,
  }))
    batches.push(batch);
  return batches;
}

test("indexes the rendered DOM instead of the empty HTML shell", async () => {
  const batches = await crawl(true);
  expect(batches.flatMap((batch) => batch.documents)).toEqual([
    expect.objectContaining({
      title: "Rendered report",
      content: "Content produced by JavaScript",
    }),
  ]);
  expect(browser.close).toHaveBeenCalled();
});
test("static mode leaves an empty shell unindexed", async () => {
  const batches = await crawl(false);
  expect(batches.flatMap((batch) => batch.documents)).toHaveLength(0);
  expect(browser.goto).not.toHaveBeenCalled();
});
test("does not index a browser navigation outside the crawl scope", async () => {
  browser.url.mockReturnValue("https://unlisted.example.org/");
  const batches = await crawl(true);
  expect(batches.flatMap((batch) => batch.documents)).toHaveLength(0);
  expect(browser.close).toHaveBeenCalled();
});
test("closes the browser when navigation fails", async () => {
  browser.goto.mockRejectedValue(new Error("Page load timed out"));
  const batches = await crawl(true);
  expect(batches.flatMap((batch) => batch.documents)).toHaveLength(0);
  expect(browser.close).toHaveBeenCalled();
});
