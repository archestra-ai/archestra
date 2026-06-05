import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { WebCrawlerConnector } from "./web-crawler-connector";

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

const servers: Array<{ close: () => Promise<void> }> = [];

describe("WebCrawlerConnector", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  test("validates crawl scope and regular expression config", async () => {
    const connector = new WebCrawlerConnector({ allowPrivateNetwork: true });

    await expect(
      connector.validateConfig({
        startUrl: "https://docs.example.test/guide/",
        includePathPrefixes: ["/guide/"],
        excludePathPatterns: ["/search"],
      }),
    ).resolves.toEqual({ valid: true });

    const invalidPattern = await connector.validateConfig({
      startUrl: "https://docs.example.test/guide/",
      excludePathPatterns: ["["],
    });
    expect(invalidPattern).toEqual({
      valid: false,
      error: "Invalid exclude path pattern: [",
    });

    const unsafePattern = await connector.validateConfig({
      startUrl: "https://docs.example.test/guide/",
      excludePathPatterns: ["(a+)+$"],
    });
    expect(unsafePattern).toEqual({
      valid: false,
      error: "Unsafe exclude path pattern: (a+)+$",
    });

    await expect(
      connector.validateConfig({
        startUrl: "https://docs.example.test/guide/",
        includePathPrefixes: ["https://docs.example.test/guide/"],
      }),
    ).resolves.toEqual({ valid: true });

    const crossOriginPrefix = await connector.validateConfig({
      startUrl: "https://docs.example.test/guide/",
      includePathPrefixes: ["https://other.example.test/guide/"],
    });
    expect(crossOriginPrefix).toEqual({
      valid: false,
      error:
        "Include path prefix URLs must use the same origin as the start URL",
    });

    const invalidUrl = await connector.validateConfig({
      startUrl: "not a url",
    });
    expect(invalidUrl).toEqual({
      valid: false,
      error: "Invalid web crawler configuration",
    });

    const excludedStartUrl = await connector.validateConfig({
      startUrl: "https://docs.example.test/guide/",
      includePathPrefixes: ["/api/"],
    });
    expect(excludedStartUrl).toEqual({
      valid: false,
      error: "Start URL is excluded by the configured crawl scope",
    });
  });

  test("blocks private network start URLs by default", async () => {
    const connector = new WebCrawlerConnector();

    const result = await connector.validateConfig({
      startUrl: "http://127.0.0.1/docs/",
    });

    expect(result).toEqual({
      valid: false,
      error: "Host 127.0.0.1 resolves to a private or internal network address",
    });
  });

  test("crawls same-host HTML pages within include/exclude scope and extracts main content", async () => {
    const seenUserAgents: string[] = [];
    const site = await createTestSite({
      "/docs/": html(`
        <html>
          <head><title>Docs Home</title></head>
          <body>
            <nav>Navigation should not be indexed</nav>
            <main>
              <h1>Docs Home</h1>
              <p>Welcome to the docs.</p>
              <a href="/docs/install.html">Install</a>
              <a href="/docs/private.html">Private</a>
              <a href="/blog/post.html">Blog</a>
              <a href="https://external.example.test/docs/outside.html">External</a>
              <a href="data:text/html,<main>Inline</main>">Data</a>
              <a href="vbscript:msgbox('x')">VBScript</a>
              <a href="javascript:alert('x')">JavaScript</a>
              <a href="mailto:support@example.test">Email</a>
              <a href="tel:+15555550123">Phone</a>
            </main>
          </body>
        </html>
      `),
      "/docs/install.html": (req, res) => {
        seenUserAgents.push(req.headers["user-agent"] ?? "");
        sendHtml(
          res,
          html(`
            <html>
              <head>
                <title>Install Guide</title>
                <link rel="canonical" href="/docs/install/">
              </head>
              <body>
                <aside>Sidebar should not be indexed</aside>
                <main>
                  <h1>Install Guide</h1>
                  <p>Install the connector package.</p>
                  <div class="feedback">Was this helpful?</div>
                </main>
              </body>
            </html>
          `),
        );
      },
      "/docs/private.html": html("<main>Do not index this page.</main>"),
      "/blog/post.html": html("<main>Outside configured docs path.</main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      includePathPrefixes: ["/docs/"],
      excludePathPatterns: ["/private"],
      excludeSelectors: [".feedback"],
      userAgent: "DocsBot/1.0",
    });
    const documents = batches.flatMap((batch) => batch.documents);

    expect(documents.map((doc) => doc.title).sort()).toEqual([
      "Docs Home",
      "Install Guide",
    ]);
    expect(documents.map((doc) => doc.sourceUrl).sort()).toEqual([
      `${site.url}/docs/`,
      `${site.url}/docs/install/`,
    ]);

    const install = documents.find((doc) => doc.title === "Install Guide");
    expect(install?.content).toContain("Install the connector package.");
    expect(install?.content).not.toContain("Sidebar should not be indexed");
    expect(install?.content).not.toContain("Was this helpful?");
    expect(install?.metadata).toMatchObject({
      type: "web_page",
      depth: 1,
      url: `${site.url}/docs/install/`,
      fetchedUrl: `${site.url}/docs/install.html`,
    });
    expect(install?.id).toBe(
      createHash("sha256").update(`${site.url}/docs/install/`).digest("hex"),
    );
    expect(seenUserAgents).toContain("DocsBot/1.0");
    expect(batches.flatMap((batch) => batch.skipped ?? [])).toEqual([]);
  });

  test("does not index a start URL that redirects to another host", async () => {
    const site = await createTestSite({
      "/docs/": (_req, res) => {
        res.writeHead(302, {
          location: "https://external.example.test/docs/",
        });
        res.end();
      },
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      maxPages: 1,
    });

    expect(batches.flatMap((batch) => batch.documents)).toEqual([]);
    expect(batches.flatMap((batch) => batch.skipped ?? [])).toEqual([
      expect.objectContaining({
        itemId: `${site.url}/docs/`,
      }),
    ]);
  });

  test("falls back to the fetched URL when canonical points to another origin", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <html>
          <head>
            <title>Cross Origin Canonical</title>
            <link rel="canonical" href="https://external.example.test/docs/">
          </head>
          <body>
            <main><h1>Cross Origin Canonical</h1></main>
          </body>
        </html>
      `),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
    });
    const [document] = batches.flatMap((batch) => batch.documents);

    expect(document.sourceUrl).toBe(`${site.url}/docs/`);
    expect(document.metadata.url).toBe(`${site.url}/docs/`);
  });

  test("respects maxDepth, maxPages, and emits batches with hasMore", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <main>
          <h1>Page 1</h1>
          <a href="/docs/page-2.html">Page 2</a>
          <a href="/docs/page-3.html">Page 3</a>
        </main>
      `),
      "/docs/page-2.html": html(`
        <main>
          <h1>Page 2</h1>
          <a href="/docs/page-4.html">Page 4</a>
        </main>
      `),
      "/docs/page-3.html": html("<main><h1>Page 3</h1></main>"),
      "/docs/page-4.html": html("<main><h1>Page 4</h1></main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      maxDepth: 1,
      maxPages: 3,
      batchSize: 2,
    });

    expect(batches).toHaveLength(2);
    expect(batches[0].documents).toHaveLength(2);
    expect(batches[0].hasMore).toBe(true);
    expect(batches[1].documents).toHaveLength(1);
    expect(batches[1].hasMore).toBe(false);
    expect(
      batches.flatMap((batch) => batch.documents.map((doc) => doc.title)),
    ).toEqual(["Page 1", "Page 2", "Page 3"]);
  });

  test("applies the configured delay between serialized requests", async () => {
    const requestedAt: number[] = [];
    const recordRequest =
      (body: string): RouteHandler =>
      (_req, res) => {
        requestedAt.push(Date.now());
        sendHtml(res, body);
      };
    const site = await createTestSite({
      "/docs/": recordRequest(
        html(`
          <main>
            <h1>Page 1</h1>
            <a href="/docs/page-2.html">Page 2</a>
            <a href="/docs/page-3.html">Page 3</a>
          </main>
        `),
      ),
      "/docs/page-2.html": recordRequest(html("<main><h1>Page 2</h1></main>")),
      "/docs/page-3.html": recordRequest(html("<main><h1>Page 3</h1></main>")),
    });

    await collectBatches({
      startUrl: `${site.url}/docs/`,
      maxDepth: 1,
      requestDelayMs: 200,
    });

    expect(requestedAt).toHaveLength(3);
    // Keep a wide tolerance so scheduling jitter does not make this flaky.
    expect(requestedAt[1] - requestedAt[0]).toBeGreaterThanOrEqual(120);
    expect(requestedAt[2] - requestedAt[1]).toBeGreaterThanOrEqual(120);
  });

  test("records failed linked pages as skipped items without failing the sync", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <main>
          <h1>Start</h1>
          <a href="/docs/missing.html">Missing</a>
        </main>
      `),
      "/docs/missing.html": (_req, res) => {
        res.writeHead(500, { "content-type": "text/html" });
        res.end("<main>Broken</main>");
      },
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      maxDepth: 1,
    });

    expect(batches.flatMap((batch) => batch.documents)).toHaveLength(1);
    expect(batches.flatMap((batch) => batch.skipped ?? [])).toEqual([
      expect.objectContaining({
        itemId: `${site.url}/docs/missing.html`,
        name: `${site.url}/docs/missing.html`,
      }),
    ]);
  });

  test("tests connectivity using the configured start URL", async () => {
    const site = await createTestSite({
      "/docs/": html("<main><h1>Reachable</h1></main>"),
      "/not-html": (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    });
    const connector = new WebCrawlerConnector({ allowPrivateNetwork: true });

    await expect(
      connector.testConnection({
        config: { startUrl: `${site.url}/docs/` },
        credentials: { apiToken: "" },
      }),
    ).resolves.toEqual({ success: true });

    const notHtml = await connector.testConnection({
      config: { startUrl: `${site.url}/not-html` },
      credentials: { apiToken: "" },
    });
    expect(notHtml.success).toBe(false);
    expect(notHtml.error).toContain("Start URL did not return indexable HTML");
  });
});

async function collectBatches(
  config: Record<string, unknown>,
): Promise<ConnectorSyncBatch[]> {
  const connector = new WebCrawlerConnector({ allowPrivateNetwork: true });
  const batches: ConnectorSyncBatch[] = [];

  for await (const batch of connector.sync({
    config,
    credentials: { apiToken: "" },
    checkpoint: null,
  })) {
    batches.push(batch);
  }

  return batches;
}

async function createTestSite(routes: Record<string, string | RouteHandler>) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const route = routes[path];

    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<main>Not found</main>");
      return;
    }

    if (typeof route === "string") {
      sendHtml(res, route);
      return;
    }

    await route(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  servers.push({ close });

  return {
    url: `http://127.0.0.1:${address.port}`,
  };
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function html(body: string): string {
  return body.trim();
}
