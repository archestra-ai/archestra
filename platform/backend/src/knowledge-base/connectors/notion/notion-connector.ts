import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  NotionCheckpoint,
  NotionConfig,
} from "@/types";
import { NotionConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";
const DEFAULT_BATCH_SIZE = 50;
const MAX_BLOCK_DEPTH = 3;

export class NotionConnector extends BaseConnector {
  type = "notion" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseNotionConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid Notion configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Notion connection");

    try {
      const response = await this.fetchWithRetry(
        `${NOTION_API_BASE}/users/me`,
        {
          headers: buildHeaders(params.credentials),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      this.log.debug("Notion connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Notion connection test failed");
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
    const parsed = parseNotionConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Notion configuration");
    }

    const checkpoint = (params.checkpoint as NotionCheckpoint | null) ?? {
      type: "notion" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();

    this.log.debug(
      { databaseIds: parsed.databaseIds, pageIds: parsed.pageIds, syncFrom },
      "Starting Notion sync",
    );

    // If specific pageIds are provided, sync those directly
    if (parsed.pageIds && parsed.pageIds.length > 0) {
      yield* this.syncSpecificPages(
        parsed,
        params.credentials,
        checkpoint,
        batchSize,
      );
      return;
    }

    // Search for pages (filtered by databaseIds if provided, otherwise all accessible pages)
    yield* this.searchAndSyncPages(
      parsed,
      params.credentials,
      checkpoint,
      syncFrom,
      batchSize,
    );
  }

  // ===== Private methods =====

  private async *syncSpecificPages(
    config: NotionConfig,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
    batchSize: number,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const pageIds = config.pageIds ?? [];
    let batchIndex = 0;

    for (let i = 0; i < pageIds.length; i += batchSize) {
      const batch = pageIds.slice(i, i + batchSize);
      const documents: ConnectorDocument[] = [];

      for (const pageId of batch) {
        await this.rateLimit();
        const result = await this.safeItemFetch({
          fetch: async () => {
            const page = await this.fetchPage(pageId, credentials);
            if (!page) return null;
            const content = await this.fetchPageContent(pageId, credentials);
            return pageToDocument(page, content);
          },
          fallback: null,
          itemId: pageId,
          resource: "page",
        });
        if (result) documents.push(result);
      }

      const hasMore = i + batchSize < pageIds.length;
      const lastDoc = documents[documents.length - 1];

      batchIndex++;
      this.log.debug(
        { batchIndex, documentCount: documents.length, hasMore },
        "Specific pages batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastDoc?.updatedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async *searchAndSyncPages(
    config: NotionConfig,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
    syncFrom: string | undefined,
    batchSize: number,
  ): AsyncGenerator<ConnectorSyncBatch> {
    let cursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, cursor }, "Fetching Notion search batch");

        const searchBody = buildSearchBody({
          databaseIds: config.databaseIds,
          syncFrom,
          cursor,
          pageSize: batchSize,
        });

        const response = await this.fetchWithRetry(
          `${NOTION_API_BASE}/search`,
          {
            method: "POST",
            headers: buildHeaders(credentials),
            body: JSON.stringify(searchBody),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Notion search failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
          );
        }

        // biome-ignore lint/suspicious/noExplicitAny: Notion API response
        const result = (await response.json()) as any;
        const results: unknown[] = result.results ?? [];

        const documents: ConnectorDocument[] = [];

        for (const item of results) {
          const page = item as Record<string, unknown>;
          if (page.object !== "page") continue;

          const pageId = String(page.id ?? "");
          if (!pageId) continue;

          try {
            const content = await this.fetchPageContent(pageId, credentials);
            documents.push(pageToDocument(page, content));
          } catch (error) {
            this.log.warn(
              { pageId, error: extractErrorMessage(error) },
              "Failed to fetch page content, using metadata only",
            );
            documents.push(pageToDocument(page, ""));
          }
        }

        cursor = result.next_cursor ?? undefined;
        hasMore = result.has_more === true && !!cursor;

        const lastResult = results[results.length - 1] as
          | Record<string, unknown>
          | undefined;
        const lastEditedAt = lastResult?.last_edited_time as string | undefined;

        this.log.debug(
          {
            batchIndex,
            pageCount: results.length,
            documentCount: documents.length,
            hasMore,
          },
          "Notion search batch done",
        );

        batchIndex++;
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastEditedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { lastEditedAt: lastEditedAt ?? checkpoint.lastEditedAt },
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "Notion search batch failed",
        );
        throw error;
      }
    }
  }

  private async fetchPage(
    pageId: string,
    credentials: ConnectorCredentials,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.fetchWithRetry(
      `${NOTION_API_BASE}/pages/${pageId}`,
      { headers: buildHeaders(credentials) },
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  private async fetchPageContent(
    blockId: string,
    credentials: ConnectorCredentials,
    depth = 0,
  ): Promise<string> {
    if (depth >= MAX_BLOCK_DEPTH) return "";

    const response = await this.fetchWithRetry(
      `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100`,
      { headers: buildHeaders(credentials) },
    );

    if (!response.ok) return "";

    // biome-ignore lint/suspicious/noExplicitAny: Notion API block response
    const result = (await response.json()) as any;
    const blocks: unknown[] = result.results ?? [];

    const parts: string[] = [];

    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      const text = extractBlockText(b);
      if (text) parts.push(text);

      if (b.has_children && depth < MAX_BLOCK_DEPTH - 1) {
        const childContent = await this.fetchPageContent(
          String(b.id),
          credentials,
          depth + 1,
        );
        if (childContent) parts.push(childContent);
      }
    }

    return parts.join("\n");
  }
}

// ===== Module-level helpers =====

function buildHeaders(
  credentials: ConnectorCredentials,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}

function buildSearchBody(params: {
  databaseIds?: string[];
  syncFrom?: string;
  cursor?: string;
  pageSize: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filter: { value: "page", property: "object" },
    sort: { direction: "ascending", timestamp: "last_edited_time" },
    page_size: params.pageSize,
  };

  if (params.cursor) {
    body.start_cursor = params.cursor;
  }

  return body;
}

function extractPageTitle(page: Record<string, unknown>): string {
  // biome-ignore lint/suspicious/noExplicitAny: Notion page properties shape varies
  const properties = page.properties as Record<string, any> | undefined;
  if (!properties) return "Untitled";

  // Try common title property names
  for (const key of ["title", "Title", "Name", "name"]) {
    const prop = properties[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title
        .map((t: Record<string, unknown>) => {
          const rt = t as Record<string, unknown>;
          return String((rt.plain_text as string | undefined) ?? "");
        })
        .join("");
      if (text.trim()) return text.trim();
    }
  }

  // Fall back to first title-type property
  for (const prop of Object.values(properties)) {
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title
        .map((t: Record<string, unknown>) =>
          String((t as Record<string, unknown>).plain_text ?? ""),
        )
        .join("");
      if (text.trim()) return text.trim();
    }
  }

  return "Untitled";
}

function extractBlockText(block: Record<string, unknown>): string {
  const type = block.type as string | undefined;
  if (!type) return "";

  // biome-ignore lint/suspicious/noExplicitAny: Notion block types
  const blockData = (block as any)[type] as Record<string, unknown> | undefined;
  if (!blockData) return "";

  const richText = blockData.rich_text as
    | Array<Record<string, unknown>>
    | undefined;
  if (!richText) return "";

  const text = richText.map((rt) => String(rt.plain_text ?? "")).join("");

  if (!text.trim()) return "";

  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    default:
      return text;
  }
}

function pageToDocument(
  page: Record<string, unknown>,
  content: string,
): ConnectorDocument {
  const id = String(page.id ?? "");
  const title = extractPageTitle(page);
  const lastEditedTime = page.last_edited_time as string | undefined;
  const url = page.url as string | undefined;

  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id,
    title,
    content: fullContent,
    sourceUrl: url,
    metadata: {
      notionPageId: id,
      lastEditedTime,
      createdTime: page.created_time as string | undefined,
      archived: page.archived as boolean | undefined,
    },
    updatedAt: lastEditedTime ? new Date(lastEditedTime) : undefined,
  };
}
