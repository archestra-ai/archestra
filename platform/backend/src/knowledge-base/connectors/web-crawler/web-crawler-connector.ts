import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  CheerioCrawler,
  type CheerioCrawlingContext,
  Configuration,
} from "@crawlee/cheerio";
import ipaddr from "ipaddr.js";
import safeRegex from "safe-regex2";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  WebCrawlerConfig,
} from "@/types";
import { WebCrawlerConfigSchema } from "@/types";
import { BaseConnector } from "../base-connector";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_PAGES = 250;
const DEFAULT_USER_AGENT = "Archestra Web Crawler";
const DEFAULT_CONTENT_SELECTORS = ["main", "article", "[role='main']", "body"];
const DEFAULT_EXCLUDE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "nav",
  "footer",
  "aside",
  "form",
  "iframe",
];
const BLOCKED_HOST_RANGES = new Set([
  "broadcast",
  "carrierGradeNat",
  "ipv4Mapped",
  "linkLocal",
  "loopback",
  "multicast",
  "private",
  "reserved",
  "rfc6145",
  "rfc6052",
  "uniqueLocal",
  "unspecified",
]);

type ExtractedPage = {
  title: string;
  content: string;
  canonicalUrl: string;
};
type CrawlerCheerioApi = CheerioCrawlingContext["$"];
type CrawlerCheerioSelection = ReturnType<CrawlerCheerioApi>;

export class WebCrawlerConnector extends BaseConnector {
  type = "web_crawler" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseWebCrawlerConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error: "Invalid web crawler configuration",
      };
    }

    const error = await validateParsedConfig({
      config: parsed,
      allowPrivateNetwork: parsed.allowPrivateNetwork ?? false,
    });
    if (error) {
      return { valid: false, error };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseWebCrawlerConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid web crawler configuration" };
    }
    const configError = await validateParsedConfig({
      config: parsed,
      allowPrivateNetwork: parsed.allowPrivateNetwork ?? false,
    });
    if (configError) {
      return { success: false, error: configError };
    }

    return this.runConnectionTest({
      label: "web crawler",
      probe: async () => {
        let sawPage = false;
        const crawler = this.createCrawler({
          config: { ...parsed, maxPages: 1, maxDepth: 0 },
          onDocument: () => {
            sawPage = true;
          },
          onSkipped: () => {},
        });

        await crawler.run([normalizeCrawlUrl(parsed.startUrl)]);
        if (!sawPage) {
          throw new Error("Start URL did not return indexable HTML content");
        }
      },
    });
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseWebCrawlerConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid web crawler configuration");
    }
    const configError = await validateParsedConfig({
      config: parsed,
      allowPrivateNetwork: parsed.allowPrivateNetwork ?? false,
    });
    if (configError) {
      throw new Error(configError);
    }

    // Web pages do not expose a uniform item-level updated timestamp, so syncs
    // use the crawl start time as the full-refresh checkpoint.
    const checkpoint = new Date().toISOString();
    const batcher = new CrawlBatcher({
      batchSize: parsed.batchSize ?? DEFAULT_BATCH_SIZE,
      checkpoint,
    });
    const crawler = this.createCrawler({
      config: parsed,
      onDocument: (document) => batcher.addDocument(document),
      onSkipped: (item) => batcher.addSkipped(item),
    });

    const crawl = crawler
      .run([normalizeCrawlUrl(parsed.startUrl)])
      .then(() => batcher.finish())
      .catch((error: unknown) => batcher.fail(error));

    try {
      for await (const batch of batcher) {
        yield batch;
      }
    } finally {
      // Always settle the crawler promise so setup/teardown errors are observed.
      await crawl;
    }
  }

  private createCrawler(params: {
    config: WebCrawlerConfig;
    onDocument: (document: ConnectorDocument) => void;
    onSkipped: (
      item: NonNullable<ConnectorSyncBatch["skipped"]>[number],
    ) => void;
  }): CheerioCrawler {
    const startUrl = normalizeCrawlUrl(params.config.startUrl);
    const allowedPathPrefixes = buildAllowedPathPrefixes(
      params.config,
      startUrl,
    );
    const excludePathPatterns = compileExcludePathPatterns(
      params.config.excludePathPatterns,
    );
    const startOrigin = new URL(startUrl).origin;
    let previousRequestCompletedAt = 0;

    return new CheerioCrawler(
      {
        maxRequestsPerCrawl: params.config.maxPages ?? DEFAULT_MAX_PAGES,
        maxRequestRetries: 2,
        minConcurrency: 1,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 60,
        preNavigationHooks: [
          async (_context, gotOptions) => {
            const requestDelayMs = params.config.requestDelayMs ?? 0;
            const elapsedMs = Date.now() - previousRequestCompletedAt;
            if (previousRequestCompletedAt > 0 && elapsedMs < requestDelayMs) {
              await sleep(requestDelayMs - elapsedMs);
            }
            await assertPublicCrawlUrl({
              url: _context.request.url,
              allowPrivateNetwork: params.config.allowPrivateNetwork ?? false,
            });

            gotOptions.headers = {
              ...gotOptions.headers,
              "User-Agent": params.config.userAgent ?? DEFAULT_USER_AGENT,
            };

            // got follows redirects internally, bypassing the per-request SSRF
            // and scope checks above. Reject cross-origin and out-of-scope
            // redirects without dialing the target (so an unreachable external
            // host can't hang the crawl, and a redirect can't pull in a path or
            // origin the crawl was scoped to exclude), and re-run the SSRF check
            // on the remaining same-origin, in-scope redirects. Origin — not
            // just hostname — matches the same-origin invariant enforced on
            // discovered links, so a redirect to another port or scheme is
            // refused too.
            gotOptions.hooks = {
              ...gotOptions.hooks,
              beforeRedirect: [
                ...(gotOptions.hooks?.beforeRedirect ?? []),
                async (redirectOptions) => {
                  if (!redirectOptions.url) return;
                  const target = new URL(redirectOptions.url);
                  if (target.origin !== startOrigin) {
                    throw new Error(
                      `Refusing to follow cross-origin redirect to ${target.href}`,
                    );
                  }
                  if (
                    !isPathInScope({
                      pathname: target.pathname,
                      search: target.search,
                      allowedPathPrefixes,
                      excludePathPatterns,
                    })
                  ) {
                    throw new Error(
                      `Refusing to follow out-of-scope redirect to ${target.href}`,
                    );
                  }
                  await assertPublicCrawlUrl({
                    url: target.href,
                    allowPrivateNetwork:
                      params.config.allowPrivateNetwork ?? false,
                  });
                },
              ],
            };
          },
        ],
        requestHandler: async (context) => {
          try {
            const depth = getRequestDepth(context.request.userData);
            const extracted = extractPage({
              $: context.$,
              requestUrl: context.request.loadedUrl ?? context.request.url,
              config: params.config,
            });

            if (!extracted.content) {
              params.onSkipped({
                itemId: context.request.url,
                name: extracted.title || context.request.url,
                reason: "empty page content",
              });
            } else {
              params.onDocument(
                buildDocument({
                  requestUrl: context.request.loadedUrl ?? context.request.url,
                  extracted,
                  depth,
                }),
              );
            }

            if (depth >= (params.config.maxDepth ?? DEFAULT_MAX_DEPTH)) {
              return;
            }

            await enqueueAllowedLinks({
              context,
              startUrl,
              currentDepth: depth,
              allowedPathPrefixes,
              excludePathPatterns,
            });
          } finally {
            previousRequestCompletedAt = Date.now();
          }
        },
        failedRequestHandler: ({ request, error }) => {
          previousRequestCompletedAt = Date.now();
          params.onSkipped({
            itemId: request.url,
            name: request.url,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
      },
      new Configuration({ persistStorage: false }),
    );
  }
}

function parseWebCrawlerConfig(
  config: Record<string, unknown>,
): WebCrawlerConfig | null {
  const parsed = WebCrawlerConfigSchema.safeParse({
    type: "web_crawler",
    ...config,
  });
  return parsed.success ? parsed.data : null;
}

async function validateParsedConfig(params: {
  config: WebCrawlerConfig;
  allowPrivateNetwork: boolean;
}): Promise<string | null> {
  const startUrl = new URL(params.config.startUrl);
  if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
    return "Start URL must use HTTP or HTTPS";
  }

  try {
    await assertPublicCrawlUrl({
      url: params.config.startUrl,
      allowPrivateNetwork: params.allowPrivateNetwork,
    });
    validateIncludePathPrefixOrigins(params.config);
    compileExcludePathPatterns(params.config.excludePathPatterns);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const normalizedStartUrl = normalizeCrawlUrl(params.config.startUrl);
  if (
    !isAllowedUrl({
      url: normalizedStartUrl,
      startUrl: normalizedStartUrl,
      allowedPathPrefixes: buildAllowedPathPrefixes(
        params.config,
        normalizedStartUrl,
      ),
      excludePathPatterns: compileExcludePathPatterns(
        params.config.excludePathPatterns,
      ),
    })
  ) {
    return "Start URL is excluded by the configured crawl scope";
  }

  return null;
}

function extractPage(params: {
  $: CrawlerCheerioApi;
  requestUrl: string;
  config: WebCrawlerConfig;
}): ExtractedPage {
  const { $, requestUrl, config } = params;
  const title =
    normalizeText($("title").first().text()) ||
    normalizeText($("h1").first().text()) ||
    requestUrl;
  const canonicalUrl = normalizeCanonicalUrl({
    canonicalHref: $("link[rel='canonical']").attr("href"),
    requestUrl,
  });
  const root = selectContentRoot($, config.contentSelector);

  for (const selector of [
    ...DEFAULT_EXCLUDE_SELECTORS,
    ...(config.excludeSelectors ?? []),
  ]) {
    root.find(selector).remove();
  }

  return {
    title,
    canonicalUrl,
    content: normalizeText(root.text()),
  };
}

async function enqueueAllowedLinks(params: {
  context: CheerioCrawlingContext;
  startUrl: string;
  currentDepth: number;
  allowedPathPrefixes: string[];
  excludePathPatterns: RegExp[];
}): Promise<void> {
  const urls = params.context
    .$("a[href]")
    .map((_idx, el) => params.context.$(el).attr("href"))
    .get()
    .map((href) => normalizeDiscoveredUrl(href, params.context.request.url))
    .filter((url): url is string => Boolean(url))
    .filter((url) =>
      isAllowedUrl({
        url,
        startUrl: params.startUrl,
        allowedPathPrefixes: params.allowedPathPrefixes,
        excludePathPatterns: params.excludePathPatterns,
      }),
    );

  await params.context.enqueueLinks({
    urls,
    userData: { depth: params.currentDepth + 1 },
  });
}

function selectContentRoot(
  $: CrawlerCheerioApi,
  contentSelector: string | undefined,
): CrawlerCheerioSelection {
  if (contentSelector) {
    const selected = $(contentSelector).first();
    if (selected.length > 0) return selected;
  }

  for (const selector of DEFAULT_CONTENT_SELECTORS) {
    const selected = $(selector).first();
    if (selected.length > 0) return selected;
  }

  return $.root();
}

function buildDocument(params: {
  requestUrl: string;
  extracted: ExtractedPage;
  depth: number;
}): ConnectorDocument {
  return {
    id: createHash("sha256")
      .update(params.extracted.canonicalUrl)
      .digest("hex"),
    title: params.extracted.title,
    content: params.extracted.content,
    sourceUrl: params.extracted.canonicalUrl,
    metadata: {
      type: "web_page",
      url: params.extracted.canonicalUrl,
      fetchedUrl: params.requestUrl,
      depth: params.depth,
    },
    updatedAt: new Date(),
  };
}

function buildAllowedPathPrefixes(
  config: WebCrawlerConfig,
  startUrl: string,
): string[] {
  if (config.includePathPrefixes && config.includePathPrefixes.length > 0) {
    return config.includePathPrefixes.map(normalizePathPrefix);
  }

  const path = new URL(startUrl).pathname;
  if (path.endsWith("/")) return [path];

  const lastSlash = path.lastIndexOf("/");
  return [path.slice(0, lastSlash + 1) || "/"];
}

function validateIncludePathPrefixOrigins(config: WebCrawlerConfig): void {
  const startOrigin = new URL(config.startUrl).origin;

  for (const prefix of config.includePathPrefixes ?? []) {
    if (!/^https?:\/\//i.test(prefix)) continue;

    const prefixUrl = new URL(prefix);
    if (prefixUrl.origin !== startOrigin) {
      throw new Error(
        "Include path prefix URLs must use the same origin as the start URL",
      );
    }
  }
}

function normalizePathPrefix(prefix: string): string {
  if (/^https?:\/\//i.test(prefix)) {
    return new URL(prefix).pathname || "/";
  }
  if (!prefix.startsWith("/")) return `/${prefix}`;
  return prefix;
}

function compileExcludePathPatterns(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).map((pattern) => {
    try {
      const regex = new RegExp(pattern);
      if (!safeRegex(regex)) {
        throw new Error(`Unsafe exclude path pattern: ${pattern}`);
      }
      return regex;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unsafe ")) {
        throw error;
      }
      throw new Error(`Invalid exclude path pattern: ${pattern}`);
    }
  });
}

function isAllowedUrl(params: {
  url: string;
  startUrl: string;
  allowedPathPrefixes: string[];
  excludePathPatterns: RegExp[];
}): boolean {
  const url = new URL(params.url);
  const startUrl = new URL(params.startUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== startUrl.origin) return false;

  return isPathInScope({
    pathname: url.pathname,
    search: url.search,
    allowedPathPrefixes: params.allowedPathPrefixes,
    excludePathPatterns: params.excludePathPatterns,
  });
}

function isPathInScope(params: {
  pathname: string;
  search: string;
  allowedPathPrefixes: string[];
  excludePathPatterns: RegExp[];
}): boolean {
  if (
    !params.allowedPathPrefixes.some((prefix) =>
      pathMatchesPrefix(params.pathname, prefix),
    )
  ) {
    return false;
  }

  return !params.excludePathPatterns.some((pattern) =>
    pattern.test(`${params.pathname}${params.search}`),
  );
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return (
    pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`)
  );
}

function normalizeDiscoveredUrl(
  rawHref: string,
  baseUrl: string,
): string | null {
  if (rawHref.startsWith("#")) return null;

  try {
    const resolved = new URL(rawHref, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    return normalizeCrawlUrl(resolved.href);
  } catch {
    return null;
  }
}

function normalizeCanonicalUrl(params: {
  canonicalHref: string | undefined;
  requestUrl: string;
}): string {
  if (!params.canonicalHref) return normalizeCrawlUrl(params.requestUrl);

  try {
    const canonicalUrl = new URL(params.canonicalHref, params.requestUrl);
    if (canonicalUrl.origin !== new URL(params.requestUrl).origin) {
      return normalizeCrawlUrl(params.requestUrl);
    }
    return normalizeCrawlUrl(canonicalUrl.href);
  } catch {
    return normalizeCrawlUrl(params.requestUrl);
  }
}

function normalizeCrawlUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  return url.href;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getRequestDepth(userData: Record<string, unknown>): number {
  return typeof userData.depth === "number" ? userData.depth : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertPublicCrawlUrl(params: {
  url: string;
  allowPrivateNetwork: boolean;
}): Promise<void> {
  if (params.allowPrivateNetwork) return;

  const hostname = new URL(params.url).hostname;
  // Crawlee performs its own HTTP request after this check, so DNS can still
  // change between validation and fetch. Re-checking in preNavigationHooks
  // narrows that window and catches rebinding across queued requests.
  const addresses = await resolveHostname(hostname);
  if (addresses.some(isBlockedAddress)) {
    throw new Error(
      `Host ${hostname} resolves to a private or internal network address`,
    );
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  if (ipaddr.isValid(hostname)) return [hostname];

  try {
    return (await lookup(hostname, { all: true })).map(
      (address) => address.address,
    );
  } catch {
    throw new Error(`Start URL host could not be resolved: ${hostname}`);
  }
}

function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;

  const parsed = ipaddr.parse(address);
  return BLOCKED_HOST_RANGES.has(parsed.range());
}

class CrawlBatcher implements AsyncIterable<ConnectorSyncBatch> {
  private documentBuffer: ConnectorDocument[] = [];
  private pendingDocuments: ConnectorDocument[] | null = null;
  private skippedBuffer: NonNullable<ConnectorSyncBatch["skipped"]> = [];
  private queue: ConnectorSyncBatch[] = [];
  private waiters: Array<() => void> = [];
  private finished = false;
  private error: unknown = null;
  private emittedBatch = false;

  constructor(
    private readonly params: {
      batchSize: number;
      checkpoint: string;
    },
  ) {}

  addDocument(document: ConnectorDocument): void {
    this.documentBuffer.push(document);
    if (this.documentBuffer.length < this.params.batchSize) return;

    if (this.pendingDocuments) {
      this.enqueueBatch(this.pendingDocuments, true);
    }
    this.pendingDocuments = this.documentBuffer.splice(
      0,
      this.params.batchSize,
    );
  }

  addSkipped(item: NonNullable<ConnectorSyncBatch["skipped"]>[number]): void {
    this.skippedBuffer.push(item);
  }

  finish(): void {
    if (this.finished) return;

    if (this.pendingDocuments) {
      this.enqueueBatch(this.pendingDocuments, this.documentBuffer.length > 0);
      this.pendingDocuments = null;
    }

    if (
      this.documentBuffer.length > 0 ||
      this.skippedBuffer.length > 0 ||
      !this.emittedBatch
    ) {
      this.enqueueBatch(this.documentBuffer.splice(0), false);
    }

    this.finished = true;
    this.notify();
  }

  fail(error: unknown): void {
    // Do not flush buffered documents after crawl failure; callers should not
    // persist a partial batch from an incomplete crawl.
    this.error = error;
    this.finished = true;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConnectorSyncBatch> {
    while (true) {
      const batch = await this.shift();
      if (!batch) return;
      yield batch;
    }
  }

  private enqueueBatch(documents: ConnectorDocument[], hasMore: boolean): void {
    const skipped = this.skippedBuffer.splice(0);
    this.queue.push({
      documents,
      checkpoint: { type: "web_crawler", lastSyncedAt: this.params.checkpoint },
      hasMore,
      skipped: skipped.length > 0 ? skipped : undefined,
    });
    this.emittedBatch = true;
    this.notify();
  }

  private async shift(): Promise<ConnectorSyncBatch | null> {
    while (this.queue.length === 0) {
      if (this.error) throw this.error;
      if (this.finished) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    return this.queue.shift() ?? null;
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }
}
