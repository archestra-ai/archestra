import { BaseConnector } from "../base-connector";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
} from "../types";
import type {
  ConfluenceCheckpoint,
  ConfluenceConfig,
  ConfluencePage,
  ConfluenceSearchResponse,
} from "./types";

const DEFAULT_BATCH_SIZE = 50;

export class ConfluenceConnector extends BaseConnector {
  type = "confluence" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Confluence configuration: confluenceUrl (string) and isCloud (boolean) are required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.confluenceUrl)) {
      return {
        valid: false,
        error: "confluenceUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Confluence configuration" };
    }

    try {
      const basePath = parsed.isCloud ? "/wiki" : "";
      const url = this.joinUrl(
        parsed.confluenceUrl,
        `${basePath}/rest/api/space?limit=1`,
      );
      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: this.buildHeaders(params.credentials),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `Confluence API error ${response.status}: ${text}`,
        };
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Confluence configuration");
    }

    const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {};
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const cql = buildCql(parsed, checkpoint, params.startTime);
    const basePath = parsed.isCloud ? "/wiki" : "";

    let start = 0;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      const searchResult = await this.searchPages({
        baseUrl: parsed.confluenceUrl,
        basePath,
        cql,
        start,
        limit: batchSize,
        credentials: params.credentials,
      });

      const documents: ConnectorDocument[] = [];

      for (const page of searchResult.results) {
        if (shouldSkipPage(page, parsed.labelsToSkip)) {
          continue;
        }

        documents.push(pageToDocument(page, parsed.confluenceUrl, basePath));
      }

      start += searchResult.limit;
      hasMore = searchResult.size >= searchResult.limit;

      const lastPage = searchResult.results[searchResult.results.length - 1];
      const newCheckpoint: ConfluenceCheckpoint = {
        lastSyncedAt: new Date().toISOString(),
        lastPageId: lastPage?.id ?? checkpoint.lastPageId,
      };

      yield {
        documents,
        checkpoint: newCheckpoint as unknown as Record<string, unknown>,
        hasMore,
      };
    }
  }

  // ===== Private methods =====

  private buildHeaders(
    credentials: ConnectorCredentials,
  ): Record<string, string> {
    return {
      Authorization: this.buildBasicAuthHeader(
        credentials.email,
        credentials.apiToken,
      ),
      Accept: "application/json",
    };
  }

  private async searchPages(params: {
    baseUrl: string;
    basePath: string;
    cql: string;
    start: number;
    limit: number;
    credentials: ConnectorCredentials;
  }): Promise<ConfluenceSearchResponse> {
    const { baseUrl, basePath, cql, start, limit, credentials } = params;
    const headers = this.buildHeaders(credentials);

    const queryParams = new URLSearchParams({
      cql,
      start: String(start),
      limit: String(limit),
      expand: "body.storage,version,space,metadata.labels",
    });

    const url = this.joinUrl(
      baseUrl,
      `${basePath}/rest/api/content/search?${queryParams.toString()}`,
    );

    const response = await this.fetchWithRetry(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Confluence search failed (${response.status}): ${text}`);
    }

    return (await response.json()) as ConfluenceSearchResponse;
  }
}

// ===== Module-level helpers =====

function parseConfluenceConfig(
  config: Record<string, unknown>,
): ConfluenceConfig | null {
  if (
    typeof config.confluenceUrl !== "string" ||
    typeof config.isCloud !== "boolean"
  ) {
    return null;
  }
  return {
    confluenceUrl: config.confluenceUrl,
    isCloud: config.isCloud,
    spaceKeys: Array.isArray(config.spaceKeys)
      ? config.spaceKeys.filter((s): s is string => typeof s === "string")
      : undefined,
    pageIds: Array.isArray(config.pageIds)
      ? config.pageIds.filter((p): p is string => typeof p === "string")
      : undefined,
    cqlQuery: typeof config.cqlQuery === "string" ? config.cqlQuery : undefined,
    labelsToSkip: Array.isArray(config.labelsToSkip)
      ? config.labelsToSkip.filter((l): l is string => typeof l === "string")
      : undefined,
    batchSize:
      typeof config.batchSize === "number" ? config.batchSize : undefined,
  };
}

function buildCql(
  config: ConfluenceConfig,
  checkpoint: ConfluenceCheckpoint,
  startTime?: Date,
): string {
  const clauses: string[] = ["type = page"];

  if (config.spaceKeys && config.spaceKeys.length > 0) {
    const spaceList = config.spaceKeys.map((k) => `"${k}"`).join(", ");
    clauses.push(`space IN (${spaceList})`);
  }

  if (config.pageIds && config.pageIds.length > 0) {
    const idList = config.pageIds.map((id) => `"${id}"`).join(", ");
    clauses.push(`content = (${idList})`);
  }

  if (config.cqlQuery) {
    clauses.push(`(${config.cqlQuery})`);
  }

  const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
  if (syncFrom) {
    const cqlDate = formatCqlDate(syncFrom);
    clauses.push(`lastModified >= "${cqlDate}"`);
  }

  return `${clauses.join(" AND ")} ORDER BY lastModified ASC`;
}

function formatCqlDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shouldSkipPage(
  page: ConfluencePage,
  labelsToSkip?: string[],
): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const pageLabels = page.metadata?.labels?.results?.map((l) => l.name) ?? [];
  return pageLabels.some((label) => labelsToSkip.includes(label));
}

function pageToDocument(
  page: ConfluencePage,
  baseUrl: string,
  basePath: string,
): ConnectorDocument {
  const htmlContent = page.body?.storage?.value ?? "";
  const plainText = stripHtmlTags(htmlContent);

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const webUiPath = page._links?.webui ?? "";
  const sourceUrl = webUiPath
    ? `${normalizedBase}${basePath}${webUiPath}`
    : undefined;

  return {
    id: page.id,
    title: page.title,
    content: `# ${page.title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      pageId: page.id,
      spaceKey: page.space?.key,
      spaceName: page.space?.name,
      status: page.status,
      labels: page.metadata?.labels?.results?.map((l) => l.name) ?? [],
    },
    updatedAt: page.version?.when ? new Date(page.version.when) : undefined,
  };
}

/**
 * Strip HTML tags to produce plain text.
 * Handles common block elements by adding newlines.
 */
export function stripHtmlTags(html: string): string {
  let text = html;
  // Replace block-level elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
