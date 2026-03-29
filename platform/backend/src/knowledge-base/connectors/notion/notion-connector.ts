import type pino from "pino";
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

// ===== Notion API types =====

interface NotionRichText {
  plain_text: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Notion block types vary widely
  [key: string]: any;
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  created_time: string;
  archived: boolean;
  properties: Record<
    string,
    {
      type: string;
      title?: NotionRichText[];
      rich_text?: NotionRichText[];
      // biome-ignore lint/suspicious/noExplicitAny: property types vary
      [key: string]: any;
    }
  >;
}

interface NotionListResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

// ===== Notion Connector =====

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
      const response = await this.fetchWithRetry(`${NOTION_API_BASE}/users/me`, {
        headers: buildHeaders(params.credentials),
      });

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

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseNotionConfig(params.config);
    if (!parsed) return null;

    // If explicit pageIds supplied, we know the count
    if (parsed.pageIds && parsed.pageIds.length > 0) {
      return parsed.pageIds.length;
    }

    // Otherwise we must search to count — skip estimation for large workspaces
    return null;
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
    const headers = buildHeaders(params.credentials);

    this.log.debug(
      {
        databaseIds: parsed.databaseIds,
        pageIds: parsed.pageIds,
        checkpoint,
      },
      "Starting Notion sync",
    );

    // === TARGETED SYNC: explicit pageIds ===
    if (parsed.pageIds && parsed.pageIds.length > 0) {
      yield* this.syncExplicitPages({
        pageIds: parsed.pageIds,
        headers,
        checkpoint,
        batchSize,
      });
      return;
    }

    // === DATABASE-FILTERED SYNC: explicit databaseIds ===
    if (parsed.databaseIds && parsed.databaseIds.length > 0) {
      yield* this.syncDatabases({
        databaseIds: parsed.databaseIds,
        headers,
        checkpoint,
        batchSize,
      });
      return;
    }

    // === FULL-WORKSPACE SYNC: /search all pages ===
    yield* this.syncAllPages({ headers, checkpoint, batchSize });
  }

  // ===== Internal sync methods =====

  private async *syncExplicitPages(params: {
    pageIds: string[];
    headers: Record<string, string>;
    checkpoint: NotionCheckpoint;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { pageIds, headers, checkpoint, batchSize } = params;
    const batch: ConnectorDocument[] = [];
    let lastSyncedAt = checkpoint.lastSyncedAt;

    for (const pageId of pageIds) {
      const page = await this.fetchPage(pageId, headers);
      if (!page || page.archived) continue;

      const doc = await this.pageToDocument(page, headers);
      if (doc) {
        batch.push(doc);
        if (doc.updatedAt) {
          lastSyncedAt = doc.updatedAt.toISOString();
        }
      }

      if (batch.length >= batchSize) {
        const failures = this.flushFailures();
        yield {
          documents: batch.splice(0),
          failures: failures.length > 0 ? failures : undefined,
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastSyncedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: true,
        };
      }

      await this.rateLimit();
    }

    if (batch.length > 0) {
      const failures = this.flushFailures();
      yield {
        documents: batch,
        failures: failures.length > 0 ? failures : undefined,
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastSyncedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: false,
      };
    } else {
      const failures = this.flushFailures();
      yield {
        documents: [],
        failures: failures.length > 0 ? failures : undefined,
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: false,
      };
    }
  }

  private async *syncDatabases(params: {
    databaseIds: string[];
    headers: Record<string, string>;
    checkpoint: NotionCheckpoint;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { databaseIds, headers, checkpoint, batchSize } = params;

    for (const databaseId of databaseIds) {
      let cursor: string | null = null;
      let lastSyncedAt = checkpoint.lastSyncedAt;

      do {
        const body: Record<string, unknown> = { page_size: batchSize };
        if (cursor) body.start_cursor = cursor;
        if (checkpoint.lastSyncedAt) {
          body.filter = {
            timestamp: "last_edited_time",
            last_edited_time: { on_or_after: checkpoint.lastSyncedAt },
          };
        }

        let response: Response;
        try {
          response = await this.fetchWithRetry(
            `${NOTION_API_BASE}/databases/${databaseId}/query`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            },
          );
        } catch (error) {
          this.log.error(
            { databaseId, error: extractErrorMessage(error) },
            "Failed to query database",
          );
          break;
        }

        if (!response.ok) {
          const text = await response.text();
          this.log.error(
            { databaseId, status: response.status, body: text.slice(0, 200) },
            "Database query failed",
          );
          break;
        }

        const data = (await response.json()) as NotionListResponse<NotionPage>;
        const documents: ConnectorDocument[] = [];

        for (const page of data.results) {
          if (page.archived) continue;
          const doc = await this.pageToDocument(page, headers);
          if (doc) {
            documents.push(doc);
            if (doc.updatedAt) {
              lastSyncedAt = doc.updatedAt.toISOString();
            }
          }
          await this.rateLimit();
        }

        const failures = this.flushFailures();
        yield {
          documents,
          failures: failures.length > 0 ? failures : undefined,
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastSyncedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: data.has_more,
        };

        cursor = data.next_cursor;
      } while (cursor);
    }
  }

  private async *syncAllPages(params: {
    headers: Record<string, string>;
    checkpoint: NotionCheckpoint;
    batchSize: number;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { headers, checkpoint, batchSize } = params;
    let cursor: string | null = null;
    let lastSyncedAt = checkpoint.lastSyncedAt;

    do {
      const body: Record<string, unknown> = {
        filter: { value: "page", property: "object" },
        page_size: batchSize,
      };
      if (cursor) body.start_cursor = cursor;

      let response: Response;
      try {
        response = await this.fetchWithRetry(`${NOTION_API_BASE}/search`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (error) {
        this.log.error(
          { error: extractErrorMessage(error) },
          "Notion search failed",
        );
        break;
      }

      if (!response.ok) {
        const text = await response.text();
        this.log.error(
          { status: response.status, body: text.slice(0, 200) },
          "Notion search error",
        );
        break;
      }

      const data = (await response.json()) as NotionListResponse<NotionPage>;
      const documents: ConnectorDocument[] = [];

      for (const page of data.results) {
        if (page.archived) continue;

        // Incremental sync: skip pages not modified since checkpoint
        if (
          checkpoint.lastSyncedAt &&
          new Date(page.last_edited_time) <= new Date(checkpoint.lastSyncedAt)
        ) {
          continue;
        }

        const doc = await this.pageToDocument(page, headers);
        if (doc) {
          documents.push(doc);
          if (doc.updatedAt) {
            lastSyncedAt = doc.updatedAt.toISOString();
          }
        }
        await this.rateLimit();
      }

      const failures = this.flushFailures();
      yield {
        documents,
        failures: failures.length > 0 ? failures : undefined,
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastSyncedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: data.has_more,
      };

      cursor = data.next_cursor;
    } while (cursor);
  }

  // ===== Page helpers =====

  private async fetchPage(
    pageId: string,
    headers: Record<string, string>,
  ): Promise<NotionPage | null> {
    try {
      const response = await this.fetchWithRetry(
        `${NOTION_API_BASE}/pages/${pageId}`,
        { headers },
      );
      if (!response.ok) return null;
      return (await response.json()) as NotionPage;
    } catch (error) {
      this.log.warn(
        { pageId, error: extractErrorMessage(error) },
        "Failed to fetch page",
      );
      return null;
    }
  }

  private async pageToDocument(
    page: NotionPage,
    headers: Record<string, string>,
  ): Promise<ConnectorDocument | null> {
    const title = extractTitle(page);
    const content = await this.safeItemFetch({
      fetch: () => this.fetchBlockContent(page.id, headers, 0),
      fallback: "",
      itemId: page.id,
      resource: "blocks",
    });

    return {
      id: page.id,
      title: title || page.id,
      content,
      sourceUrl: page.url,
      metadata: {
        pageId: page.id,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
      },
      updatedAt: new Date(page.last_edited_time),
    };
  }

  private async fetchBlockContent(
    blockId: string,
    headers: Record<string, string>,
    depth: number,
  ): Promise<string> {
    if (depth >= MAX_BLOCK_DEPTH) return "";

    const parts: string[] = [];
    let cursor: string | null = null;

    do {
      const url = cursor
        ? `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
        : `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100`;

      let response: Response;
      try {
        response = await this.fetchWithRetry(url, { headers });
      } catch {
        break;
      }

      if (!response.ok) break;

      const data = (await response.json()) as NotionListResponse<NotionBlock>;

      for (const block of data.results) {
        const text = blockToMarkdown(block);
        if (text) parts.push(text);

        if (block.has_children && depth + 1 < MAX_BLOCK_DEPTH) {
          const childContent = await this.fetchBlockContent(
            block.id,
            headers,
            depth + 1,
          );
          if (childContent) parts.push(childContent);
        }

        await this.rateLimit();
      }

      cursor = data.next_cursor;
    } while (cursor);

    return parts.join("\n");
  }
}

// ===== Internal helpers =====

function parseNotionConfig(config: Record<string, unknown>): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}

function buildHeaders(credentials: ConnectorCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function extractTitle(page: NotionPage): string {
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return "";
}

/**
 * Convert a Notion block to a Markdown string.
 * Handles the most common block types used in knowledge base content.
 */
function blockToMarkdown(block: NotionBlock): string {
  const type = block.type;
  const data = block[type] as Record<string, unknown> | undefined;
  if (!data) return "";

  const richText = (data.rich_text as NotionRichText[] | undefined) ?? [];
  const text = richText.map((t) => t.plain_text).join("");

  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return text ? `# ${text}` : "";
    case "heading_2":
      return text ? `## ${text}` : "";
    case "heading_3":
      return text ? `### ${text}` : "";
    case "bulleted_list_item":
      return text ? `- ${text}` : "";
    case "numbered_list_item":
      return text ? `1. ${text}` : "";
    case "to_do": {
      const checked = (data.checked as boolean | undefined) ?? false;
      return text ? `- [${checked ? "x" : " "}] ${text}` : "";
    }
    case "toggle":
      return text ? `> ${text}` : "";
    case "quote":
      return text ? `> ${text}` : "";
    case "callout":
      return text ? `> ${text}` : "";
    case "code": {
      const language = (data.language as string | undefined) ?? "";
      return text ? `\`\`\`${language}\n${text}\n\`\`\`` : "";
    }
    case "divider":
      return "---";
    case "table_of_contents":
      return "";
    case "equation":
      return (data.expression as string | undefined) ?? "";
    default:
      return text;
  }
}
