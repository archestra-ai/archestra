import { createHash } from "node:crypto";
import {
  CheerioCrawler,
  type CheerioCrawlingContext,
} from "@crawlee/cheerio";
import type { AnyNode, Cheerio, CheerioAPI } from "cheerio";
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

type ExtractedPage = {
  title: string;
  content: string;
  canonicalUrl: string;
};

function parseWebCrawlerConfig(
  config: Record<string, unknown>,
): WebCrawlerConfig | null {
  const parsed = WebCrawlerConfigSchema.safeParse({
    type: "web_crawler",
    ...config,
  });
  return parsed.success ? parsed.data : null;
}

export class WebCrawlerConnector extends BaseConnector {
  type = "web_crawler" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseWebCrawlerConfig,
      label: "web crawler",
      invalidConfigError: "Invalid web crawler configuration",
      extraChecks: validateParsedConfig,
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseWebCrawlerConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid web crawler configuration" };
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

    const documents: ConnectorDocument[] = [];
    const skipped: NonNullable<ConnectorSyncBatch["skipped"]> = [];
    const checkpoint = new Date().toISOString();
    const crawler = this.createCrawler({
      config: parsed,
      onDocument: (document) => documents.push(document),
      onSkipped: (item) => skipped.push(item),
    });

    await crawler.run([normalizeCrawlUrl(parsed.startUrl)]);

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    for (let i = 0; i < documents.length; i += batchSize) {
      yield {
        documents: documents.slice(i, i + batchSize),
        checkpoint: { type: "web_crawler", lastSyncedAt: checkpoint },
        hasMore: i + batchSize < documents.length,
        skipped: i === 0 ? skipped : undefined,
      };
    }

    if (documents.length === 0) {
      yield {
        documents: [],
        checkpoint: { type: "web_crawler", lastSyncedAt: checkpoint },
        hasMore: false,
        skipped,
      };
    }
  }

  private createCrawler(params: {
    config: WebCrawlerConfig;
    onDocument: (document: ConnectorDocument) => void;
    onSkipped: (item: NonNullable<ConnectorSyncBatch["skipped"]>[number]) => void;
  }): CheerioCrawler {
    const startUrl = normalizeCrawlUrl(params.config.startUrl);
    const allowedPathPrefixes = buildAllowedPathPrefixes(
      params.config,
      startUrl,
    );
    const excludePathPatterns = compileExcludePathPatterns(
      params.config.excludePathPatterns,
    );

    return new CheerioCrawler(
      {
        maxRequestsPerCrawl: params.config.maxPages ?? DEFAULT_MAX_PAGES,
        maxRequestRetries: 2,
        minConcurrency: 1,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 60,
        preNavigationHooks: [
          (_context, gotOptions) => {
            gotOptions.headers = {
              ...gotOptions.headers,
              "User-Agent": params.config.userAgent ?? DEFAULT_USER_AGENT,
            };
          },
        ],
        requestHandler: async (context) => {
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
        },
        failedRequestHandler: ({ request, error }) => {
          params.onSkipped({
            itemId: request.url,
            name: request.url,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
      },
      {
        persistStorage: false,
      },
    );
  }
}

function validateParsedConfig(config: WebCrawlerConfig): string | null {
  const startUrl = new URL(config.startUrl);
  if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
    return "Start URL must use HTTP or HTTPS";
  }

  try {
    compileExcludePathPatterns(config.excludePathPatterns);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return null;
}

function extractPage(params: {
  $: CheerioAPI;
  requestUrl: string;
  config: WebCrawlerConfig;
}): ExtractedPage {
  const { $, requestUrl, config } = params;
  const title =
    normalizeText($("title").first().text()) ||
    normalizeText($("h1").first().text()) ||
    requestUrl;
  const canonicalHref = $("link[rel='canonical']").attr("href");
  const canonicalUrl = normalizeCrawlUrl(
    canonicalHref ? new URL(canonicalHref, requestUrl).href : requestUrl,
  );
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
  const urls = params.context.$("a[href]")
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
  $: CheerioAPI,
  contentSelector: string | undefined,
): Cheerio<AnyNode> {
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
    id: createHash("sha256").update(params.extracted.canonicalUrl).digest("hex"),
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
      return new RegExp(pattern);
    } catch {
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

  if (url.origin !== startUrl.origin) return false;
  if (
    !params.allowedPathPrefixes.some((prefix) =>
      url.pathname.startsWith(prefix),
    )
  ) {
    return false;
  }

  return !params.excludePathPatterns.some((pattern) =>
    pattern.test(`${url.pathname}${url.search}`),
  );
}

function normalizeDiscoveredUrl(
  rawHref: string,
  baseUrl: string,
): string | null {
  if (
    rawHref.startsWith("#") ||
    rawHref.startsWith("mailto:") ||
    rawHref.startsWith("tel:") ||
    rawHref.startsWith("javascript:")
  ) {
    return null;
  }

  try {
    return normalizeCrawlUrl(new URL(rawHref, baseUrl).href);
  } catch {
    return null;
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
