import { ConfluenceClient } from "confluence.js";
import type {
  ConfluenceCheckpoint,
  ConfluenceConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
} from "@/types/knowledge-connector";
import { ConfluenceConfigSchema } from "@/types/knowledge-connector";
import { BaseConnector, buildCheckpoint } from "../base-connector";

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
      const client = createConfluenceClient(parsed, params.credentials);
      await client.space.getSpaces({ limit: 1 });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      const client = createConfluenceClient(parsed, params.credentials);

      const result = await client.content.searchContentByCQL({
        cql,
        limit: 1,
      });
      // The REST API returns totalSize but the SDK type doesn't include it
      // biome-ignore lint/suspicious/noExplicitAny: SDK type missing totalSize field
      const totalSize = (result as any).totalSize as number | undefined;
      return totalSize ?? null;
    } catch {
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
    const client = createConfluenceClient(parsed, params.credentials);

    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

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

      yield {
        documents,
        checkpoint: buildCheckpoint({
          type: "confluence",
          itemUpdatedAt: lastPage?.version?.when,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
          extra: { lastPageId: lastPage?.id ?? checkpoint.lastPageId },
        }),
        hasMore,
      };
    }
  }
}

// ===== Module-level helpers =====

function createConfluenceClient(
  config: ConfluenceConfig,
  credentials: ConnectorCredentials,
) {
  const host = config.confluenceUrl.replace(/\/+$/, "");
  return new ConfluenceClient({
    host,
    authentication: {
      basic: {
        email: credentials.email ?? "",
        apiToken: credentials.apiToken,
      },
    },
    apiPrefix: config.isCloud ? "/wiki/rest/" : "/rest/",
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
