import { ConfluenceClient } from "confluence.js";
import type pino from "pino";
import type {
  ConfluenceCheckpoint,
  ConfluenceConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
} from "@/types/knowledge-connector";
import { ConfluenceConfigSchema } from "@/types/knowledge-connector";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

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

    this.log.debug(
      { baseUrl: parsed.confluenceUrl, isCloud: parsed.isCloud },
      "[ConfluenceConnector] Testing connection",
    );

    try {
      const client = createConfluenceClient(
        parsed,
        params.credentials,
        this.log,
      );
      await client.space.getSpaces({ limit: 1 });
      this.log.debug("[ConfluenceConnector] Connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error(
        { error: message },
        "[ConfluenceConnector] Connection test failed",
      );
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
        type: "confluence" as const,
      };
      const cql = buildCql(parsed, checkpoint);

      this.log.debug({ cql }, "[ConfluenceConnector] Estimating total items");

      const client = createConfluenceClient(
        parsed,
        params.credentials,
        this.log,
      );

      const result = await client.content.searchContentByCQL({
        cql,
        limit: 1,
      });
      // The REST API returns totalSize but the SDK type doesn't include it
      // biome-ignore lint/suspicious/noExplicitAny: SDK type missing totalSize field
      const totalSize = (result as any).totalSize as number | undefined;
      return totalSize ?? null;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "[ConfluenceConnector] Failed to estimate total items",
      );
      return null;
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

    const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
      type: "confluence" as const,
    };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const cql = buildCql(parsed, checkpoint, params.startTime);
    const client = createConfluenceClient(parsed, params.credentials, this.log);

    this.log.debug(
      {
        baseUrl: parsed.confluenceUrl,
        isCloud: parsed.isCloud,
        spaceKeys: parsed.spaceKeys,
        cql,
        checkpoint,
      },
      "[ConfluenceConnector] Starting sync",
    );

    let cursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { batchIndex, cursor },
          "[ConfluenceConnector] Fetching batch",
        );

        const searchResult = await client.content.searchContentByCQL({
          cql,
          cursor,
          limit: batchSize,
          expand: ["body.storage", "version", "space", "metadata.labels"],
        });

        const results = searchResult.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of results) {
          if (shouldSkipPage(page, parsed.labelsToSkip)) {
            continue;
          }

          documents.push(
            pageToDocument(page, parsed.confluenceUrl, parsed.isCloud),
          );
        }

        // Extract cursor from _links.next if available
        // biome-ignore lint/suspicious/noExplicitAny: SDK links type
        const links = (searchResult as any)._links;
        const nextUrl: string | undefined = links?.next;
        if (nextUrl) {
          const cursorMatch = nextUrl.match(/cursor=([^&]+)/);
          cursor = cursorMatch ? decodeURIComponent(cursorMatch[1]) : undefined;
        } else {
          cursor = undefined;
        }
        hasMore = results.length >= batchSize && !!cursor;

        const lastPage = results[results.length - 1];
        const rawModifiedAt: string | undefined = lastPage?.version?.when;

        this.log.debug(
          {
            batchIndex,
            pageCount: results.length,
            documentCount: documents.length,
            hasMore,
          },
          "[ConfluenceConnector] Batch fetched",
        );

        batchIndex++;
        yield {
          documents,
          checkpoint: buildCheckpoint({
            type: "confluence",
            itemUpdatedAt: rawModifiedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: {
              lastPageId: lastPage?.id ?? checkpoint.lastPageId,
              lastRawModifiedAt: rawModifiedAt ?? checkpoint.lastRawModifiedAt,
            },
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "[ConfluenceConnector] Batch fetch failed",
        );
        throw error;
      }
    }
  }
}

// ===== Module-level helpers =====

function createConfluenceClient(
  config: ConfluenceConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
) {
  const host = config.confluenceUrl.replace(/\/+$/, "");
  return new ConfluenceClient({
    host,
    noCheckAtlassianToken: true,
    authentication: credentials.email
      ? { basic: { email: credentials.email, apiToken: credentials.apiToken } }
      : { oauth2: { accessToken: credentials.apiToken } },
    apiPrefix: config.isCloud ? "/wiki/rest/" : "/rest/",
    middlewares: {
      onError: (error: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: Axios error shape
        const err = error as any;
        log.debug(
          {
            status: err?.response?.status,
            method: err?.config?.method?.toUpperCase(),
            url: err?.config?.url,
            error: err?.message ?? String(error),
          },
          "[ConfluenceConnector] HTTP error",
        );
      },
      onResponse: (response: unknown) => {
        // biome-ignore lint/suspicious/noExplicitAny: Axios response shape
        const res = response as any;
        log.debug(
          {
            status: res?.status,
            method: res?.config?.method?.toUpperCase(),
            url: res?.config?.url,
          },
          "[ConfluenceConnector] HTTP response",
        );
      },
    },
  });
}

function parseConfluenceConfig(
  config: Record<string, unknown>,
): ConfluenceConfig | null {
  const result = ConfluenceConfigSchema.safeParse({
    type: "confluence",
    ...config,
  });
  return result.success ? result.data : null;
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

  // Prefer the raw Confluence timestamp (includes timezone offset) so the CQL date
  // is formatted in the user's local timezone.  Fall back to UTC lastSyncedAt for
  // backward compatibility with old checkpoints — subtract 1 day as safety buffer
  // to account for unknown timezone offsets (CQL uses day-level precision).
  const rawTimestamp = checkpoint.lastRawModifiedAt;
  if (rawTimestamp) {
    const cqlDate = formatCqlLocalDate(rawTimestamp);
    clauses.push(`lastModified >= "${cqlDate}"`);
  } else {
    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) {
      const cqlDate = formatCqlDateWithSafetyBuffer(syncFrom);
      clauses.push(`lastModified >= "${cqlDate}"`);
    }
  }

  return `${clauses.join(" AND ")} ORDER BY lastModified ASC`;
}

/**
 * Extract the LOCAL date from an ISO 8601 timestamp with timezone offset.
 * CQL interprets date literals in the authenticating user's timezone.
 */
export function formatCqlLocalDate(rawTimestamp: string): string {
  const match = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return formatCqlDate(rawTimestamp);
}

/**
 * Format a UTC ISO timestamp for CQL, subtracting 1 day to account for
 * timezone offsets. CQL uses day precision so 1 day buffer is sufficient.
 * Used only for old checkpoints that lack `lastRawModifiedAt`.
 */
function formatCqlDateWithSafetyBuffer(isoDate: string): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - 1);
  return formatCqlDate(d.toISOString());
}

function formatCqlDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// biome-ignore lint/suspicious/noExplicitAny: SDK content types
function shouldSkipPage(page: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const pageLabels: string[] =
    page.metadata?.labels?.results?.map((l: { name: string }) => l.name) ?? [];
  return pageLabels.some((label) => labelsToSkip.includes(label));
}

function pageToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: SDK content types
  page: any,
  baseUrl: string,
  isCloud: boolean,
): ConnectorDocument {
  const htmlContent: string = page.body?.storage?.value ?? "";
  const plainText = stripHtmlTags(htmlContent);

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const basePath = isCloud ? "/wiki" : "";
  const webUiPath: string = page._links?.webui ?? "";
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
      labels:
        page.metadata?.labels?.results?.map((l: { name: string }) => l.name) ??
        [],
    },
    updatedAt: page.version?.when ? new Date(page.version.when) : undefined,
  };
}

/**
 * Strip HTML tags to produce plain text.
 */
export function stripHtmlTags(html: string): string {
  let text = html;
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Loop to handle nested/broken tags like <scr<script>ipt>
  let prev: string;
  do {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== prev);
  // Decode entities in a single pass to avoid double-unescaping
  text = text.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_match, entity: string) => HTML_ENTITY_MAP[entity] ?? _match,
  );
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};
