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
    const connector = new WebCrawlerConnector();
    // The crawl-scope assertions target an unresolvable test domain, so opt into
    // private-network access to skip the DNS/SSRF gate and reach scope checks.
    const base = { allowPrivateNetwork: true };

    await expect(
      connector.validateConfig({
        ...base,
        startUrl: "https://docs.example.test/guide/",
        includePathPrefixes: ["/guide/"],
        excludePathPatterns: ["/search"],
      }),
    ).resolves.toEqual({ valid: true });

    const invalidPattern = await connector.validateConfig({
      ...base,
      startUrl: "https://docs.example.test/guide/",
      excludePathPatterns: ["["],
    });
    expect(invalidPattern).toEqual({
      valid: false,
      error: "Invalid exclude path pattern: [",
    });

    const unsafePattern = await connector.validateConfig({
      ...base,
      startUrl: "https://docs.example.test/guide/",
      excludePathPatterns: ["(a+)+$"],
    });
    expect(unsafePattern).toEqual({
      valid: false,
      error: "Unsafe exclude path pattern: (a+)+$",
    });

    await expect(
      connector.validateConfig({
        ...base,
        startUrl: "https://docs.example.test/guide/",
        includePathPrefixes: ["https://docs.example.test/guide/"],
      }),
    ).resolves.toEqual({ valid: true });

    const crossOriginPrefix = await connector.validateConfig({
      ...base,
      startUrl: "https://docs.example.test/guide/",
      includePathPrefixes: ["https://other.example.test/guide/"],
    });
    expect(crossOriginPrefix).toEqual({
      valid: false,
      error:
        "Include path prefix URLs must use the same origin as the start URL",
    });

    const invalidUrl = await connector.validateConfig({
      ...base,
      startUrl: "not a url",
    });
    expect(invalidUrl).toEqual({
      valid: false,
      error: "Invalid web crawler configuration",
    });

    const excludedStartUrl = await connector.validateConfig({
      ...base,
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

  test("allows private network start URLs when the config opts in", async () => {
    const connector = new WebCrawlerConnector();

    const result = await connector.validateConfig({
      startUrl: "http://127.0.0.1/docs/",
      allowPrivateNetwork: true,
    });

    expect(result).toEqual({ valid: true });
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
        reason: expect.stringContaining("cross-origin redirect"),
      }),
    ]);
  });

  test("does not follow a redirect to a different port on the same host", async () => {
    const site = await createTestSite({
      "/docs/": (_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:9/docs/" });
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
        reason: expect.stringContaining("cross-origin redirect"),
      }),
    ]);
  });

  test("does not follow a redirect that changes the scheme", async () => {
    const site = await createTestSite({
      "/docs/": (req, res) => {
        res.writeHead(302, {
          location: `https://${req.headers.host}/docs/`,
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
        reason: expect.stringContaining("cross-origin redirect"),
      }),
    ]);
  });

  test("follows a same-host redirect and indexes the destination", async () => {
    const site = await createTestSite({
      "/docs/start/": (_req, res) => {
        res.writeHead(302, { location: "/docs/dest/" });
        res.end();
      },
      "/docs/dest/": html("<main><h1>Destination</h1></main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/start/`,
      includePathPrefixes: ["/docs/"],
    });
    const documents = batches.flatMap((batch) => batch.documents);

    expect(documents.map((doc) => doc.title)).toEqual(["Destination"]);
    expect(documents[0]?.sourceUrl).toBe(`${site.url}/docs/dest/`);
  });

  test("does not follow a same-host redirect that leaves the crawl scope", async () => {
    const site = await createTestSite({
      "/docs/": (_req, res) => {
        res.writeHead(302, { location: "/admin/secrets/" });
        res.end();
      },
      "/admin/secrets/": html("<main><h1>Secrets</h1></main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      includePathPrefixes: ["/docs/"],
    });

    expect(batches.flatMap((batch) => batch.documents)).toEqual([]);
    expect(batches.flatMap((batch) => batch.skipped ?? [])).toEqual([
      expect.objectContaining({
        itemId: `${site.url}/docs/`,
        reason: expect.stringContaining("out-of-scope redirect"),
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
    const connector = new WebCrawlerConnector();

    await expect(
      connector.testConnection({
        config: { startUrl: `${site.url}/docs/`, allowPrivateNetwork: true },
        credentials: { apiToken: "" },
      }),
    ).resolves.toEqual({ success: true });

    const notHtml = await connector.testConnection({
      config: { startUrl: `${site.url}/not-html`, allowPrivateNetwork: true },
      credentials: { apiToken: "" },
    });
    expect(notHtml.success).toBe(false);
    expect(notHtml.error).toContain("Start URL did not return indexable HTML");
  });

  test("testConnection reports invalid configuration", async () => {
    const connector = new WebCrawlerConnector();

    const result = await connector.testConnection({
      config: { startUrl: "not a url" },
      credentials: { apiToken: "" },
    });

    expect(result).toEqual({
      success: false,
      error: "Invalid web crawler configuration",
    });
  });

  test("testConnection surfaces config validation errors", async () => {
    const connector = new WebCrawlerConnector();

    const result = await connector.testConnection({
      config: { startUrl: "http://127.0.0.1/docs/" },
      credentials: { apiToken: "" },
    });

    expect(result).toEqual({
      success: false,
      error: "Host 127.0.0.1 resolves to a private or internal network address",
    });
  });

  test("sync throws on invalid configuration", async () => {
    const connector = new WebCrawlerConnector();

    await expect(
      firstSync(connector, { startUrl: "not a url" }),
    ).rejects.toThrow("Invalid web crawler configuration");
  });

  test("sync throws when the start URL fails scope validation", async () => {
    const connector = new WebCrawlerConnector();

    await expect(
      firstSync(connector, { startUrl: "http://127.0.0.1/docs/" }),
    ).rejects.toThrow(
      "Host 127.0.0.1 resolves to a private or internal network address",
    );
  });

  test("validateConfig rejects start URLs whose host cannot be resolved", async () => {
    const connector = new WebCrawlerConnector();

    const result = await connector.validateConfig({
      startUrl: "http://nonexistent-archestra.invalid/docs/",
    });

    expect(result).toEqual({
      valid: false,
      error:
        "Start URL host could not be resolved: nonexistent-archestra.invalid",
    });
  });

  test("validateConfig accepts a public IP literal start URL", async () => {
    const connector = new WebCrawlerConnector();

    await expect(
      connector.validateConfig({ startUrl: "http://8.8.8.8/" }),
    ).resolves.toEqual({ valid: true });
  });

  test("skips pages whose content selector yields no text", async () => {
    const site = await createTestSite({
      "/docs/": html("<main></main>"),
    });

    const batches = await collectBatches({ startUrl: `${site.url}/docs/` });

    expect(batches.flatMap((batch) => batch.documents)).toEqual([]);
    expect(batches.flatMap((batch) => batch.skipped ?? [])).toEqual([
      expect.objectContaining({
        itemId: `${site.url}/docs/`,
        reason: "empty page content",
      }),
    ]);
  });

  test("derives the title from h1 then the URL when no title tag exists", async () => {
    const headingSite = await createTestSite({
      "/docs/": html(
        "<main><h1>Heading Only</h1><p>Some body copy.</p></main>",
      ),
    });
    const headingBatches = await collectBatches({
      startUrl: `${headingSite.url}/docs/`,
    });
    expect(headingBatches.flatMap((batch) => batch.documents)[0]?.title).toBe(
      "Heading Only",
    );

    const bareSite = await createTestSite({
      "/docs/": html("<main><p>No heading or title here.</p></main>"),
    });
    const bareBatches = await collectBatches({
      startUrl: `${bareSite.url}/docs/`,
    });
    expect(bareBatches.flatMap((batch) => batch.documents)[0]?.title).toBe(
      `${bareSite.url}/docs/`,
    );
  });

  test("extracts content from a custom content selector", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <main>Fallback main content.</main>
        <div class="content"><p>Selector-targeted content.</p></div>
      `),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      contentSelector: ".content",
    });
    const [document] = batches.flatMap((batch) => batch.documents);

    expect(document.content).toContain("Selector-targeted content.");
    expect(document.content).not.toContain("Fallback main content.");
  });

  test("scopes the crawl to the start URL's directory when it is a file", async () => {
    const site = await createTestSite({
      "/docs/intro.html": html(`
        <main>
          <h1>Intro</h1>
          <a href="/docs/next.html">Next</a>
          <a href="/blog/post.html">Off scope</a>
        </main>
      `),
      "/docs/next.html": html("<main><h1>Next</h1></main>"),
      "/blog/post.html": html("<main><h1>Off scope</h1></main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/intro.html`,
    });
    const titles = batches
      .flatMap((batch) => batch.documents)
      .map((doc) => doc.title)
      .sort();

    expect(titles).toEqual(["Intro", "Next"]);
  });

  test("crawls the whole host when started at the root with no prefixes", async () => {
    const site = await createTestSite({
      "/": html('<main><h1>Home</h1><a href="/about.html">About</a></main>'),
      "/about.html": html("<main><h1>About</h1></main>"),
    });

    const batches = await collectBatches({ startUrl: `${site.url}/` });
    const titles = batches
      .flatMap((batch) => batch.documents)
      .map((doc) => doc.title)
      .sort();

    expect(titles).toEqual(["About", "Home"]);
  });

  test("normalizes include path prefixes that omit the leading slash", async () => {
    const site = await createTestSite({
      "/docs/": html(
        '<main><h1>Docs</h1><a href="/docs/sub.html">Sub</a></main>',
      ),
      "/docs/sub.html": html("<main><h1>Sub</h1></main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      includePathPrefixes: ["docs"],
    });
    const titles = batches
      .flatMap((batch) => batch.documents)
      .map((doc) => doc.title)
      .sort();

    expect(titles).toEqual(["Docs", "Sub"]);
  });

  test("ignores fragment and non-HTTP links when discovering pages", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <main>
          <h1>Docs</h1>
          <a href="#section">Anchor</a>
          <a href="mailto:hi@example.test">Mail</a>
          <a href="/docs/real.html">Real</a>
        </main>
      `),
      "/docs/real.html": html("<main><h1>Real</h1></main>"),
    });

    const batches = await collectBatches({ startUrl: `${site.url}/docs/` });
    const urls = batches
      .flatMap((batch) => batch.documents)
      .map((doc) => doc.sourceUrl)
      .sort();

    expect(urls).toEqual([`${site.url}/docs/`, `${site.url}/docs/real.html`]);
  });

  test("falls back to the fetched URL when the canonical link is malformed", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <html>
          <head>
            <title>Bad Canonical</title>
            <link rel="canonical" href="http://">
          </head>
          <body><main><h1>Bad Canonical</h1></main></body>
        </html>
      `),
    });

    const batches = await collectBatches({ startUrl: `${site.url}/docs/` });
    const [document] = batches.flatMap((batch) => batch.documents);

    expect(document.sourceUrl).toBe(`${site.url}/docs/`);
    expect(document.metadata.url).toBe(`${site.url}/docs/`);
  });

  test("emits one batch per document and flags hasMore until the last", async () => {
    const site = await createTestSite({
      "/docs/": html(`
        <main>
          <h1>Page 1</h1>
          <a href="/docs/page-2.html">Page 2</a>
          <a href="/docs/page-3.html">Page 3</a>
        </main>
      `),
      "/docs/page-2.html": html("<main><h1>Page 2</h1></main>"),
      "/docs/page-3.html": html("<main><h1>Page 3</h1></main>"),
    });

    const batches = await collectBatches({
      startUrl: `${site.url}/docs/`,
      batchSize: 1,
    });

    expect(batches.flatMap((batch) => batch.documents)).toHaveLength(3);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.at(-1)?.hasMore).toBe(false);
    expect(batches.slice(0, -1).every((batch) => batch.hasMore)).toBe(true);
  });
});

function firstSync(
  connector: WebCrawlerConnector,
  config: Record<string, unknown>,
): Promise<IteratorResult<ConnectorSyncBatch>> {
  return connector
    .sync({ config, credentials: { apiToken: "" }, checkpoint: null })
    .next();
}

async function collectBatches(
  config: Record<string, unknown>,
): Promise<ConnectorSyncBatch[]> {
  const connector = new WebCrawlerConnector();
  const batches: ConnectorSyncBatch[] = [];

  for await (const batch of connector.sync({
    // Tests crawl a loopback test server, so opt into private-network access.
    config: { allowPrivateNetwork: true, ...config },
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
