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
  REQUEST_TIMEOUT_MS,
} from "../base-connector";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";
const BATCH_SIZE = 50;
const BLOCK_DEPTH_LIMIT = 3;

export class NotionConnector extends BaseConnector {
  type = "notion" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseNotionConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Notion configuration: integrationToken (string) is required",
      };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseNotionConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Notion configuration" };
    }

    this.log.debug("Testing Notion API connection");

    try {
      await this.notionFetch("/search", params.credentials, {
        method: "POST",
        body: JSON.stringify({ page_size: 1 }),
      });
      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Connection test failed");
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

    const checkpoint =
      (params.checkpoint as NotionCheckpoint | null) ?? buildDefaultCheckpoint();

    // Determine sync mode
    const hasExplicitTargets =
      (parsed.databaseIds?.length ?? 0) > 0 ||
      (parsed.pageIds?.length ?? 0) > 0;

    // 1. Full-workspace search when no explicit targets specified
    if (!hasExplicitTargets) {
      this.log.debug("No explicit targets — running full workspace search");
      yield* this.syncWorkspaceSearch(parsed, params.credentials, checkpoint);
    }

    // 2. Sync specific databases
    if (parsed.databaseIds?.length) {
      for (const databaseId of parsed.databaseIds) {
        yield* this.syncDatabase(databaseId, params.credentials, checkpoint);
      }
    }

    // 3. Sync specific pages
    if (parsed.pageIds?.length) {
      for (const pageId of parsed.pageIds) {
        yield* this.syncPage(pageId, params.credentials, checkpoint);
      }
    }
  }

  private async *syncWorkspaceSearch(
    config: NotionConfig,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    this.log.debug("Starting workspace search sync");

    let cursor: string | undefined;
    let hasMore = true;
    let lastEditedTime: string | undefined;

    while (hasMore) {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        page_size: BATCH_SIZE,
        filter: { value: "page", property: "object" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
      };

      if (cursor) {
        body.start_cursor = cursor;
      }

      let response: NotionPaginatedResponse<NotionPage>;
      try {
        response = (await this.notionFetch("/search", credentials, {
          method: "POST",
          body: JSON.stringify(body),
        })) as NotionPaginatedResponse<NotionPage>;
      } catch (error) {
        const message = extractErrorMessage(error);
        this.log.error({ error: message }, "Workspace search failed");
        throw error;
      }

      const pages = response.results ?? [];
      hasMore = response.has_more === true;
      cursor = response.next_cursor ?? undefined;

      if (pages.length === 0 && !hasMore) {
        yield {
          documents: [],
          failures: this.flushFailures(),
          checkpoint,
          hasMore: false,
        };
        return;
      }

      const documents: ConnectorDocument[] = [];
      for (const page of pages) {
        const doc = await this.pageToDocument(page, credentials);
        if (doc) documents.push(doc);
        if (!lastEditedTime || page.last_edited_time > lastEditedTime) {
          lastEditedTime = page.last_edited_time;
        }
      }

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastEditedTime,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async *syncDatabase(
    databaseId: string,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    this.log.debug({ databaseId }, "Syncing Notion database");

    let cursor: string | undefined;
    let hasMore = true;
    let lastEditedTime: string | undefined;

    while (hasMore) {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        page_size: BATCH_SIZE,
        filter: { property: "object", value: "page" },
      };

      if (cursor) {
        body.start_cursor = cursor;
      }

      let response: NotionPaginatedResponse<NotionPage>;
      try {
        response = (await this.notionFetch(
          `/databases/${databaseId}/query`,
          credentials,
          { method: "POST", body: JSON.stringify(body) },
        )) as NotionPaginatedResponse<NotionPage>;
      } catch (error) {
        const message = extractErrorMessage(error);
        this.log.error({ databaseId, error: message }, "Database query failed");
        throw error;
      }

      const pages = response.results ?? [];
      hasMore = response.has_more === true;
      cursor = response.next_cursor ?? undefined;

      if (pages.length === 0 && !hasMore) {
        yield {
          documents: [],
          failures: this.flushFailures(),
          checkpoint,
          hasMore: false,
        };
        return;
      }

      const documents: ConnectorDocument[] = [];
      for (const page of pages) {
        const doc = await this.pageToDocument(page, credentials);
        if (doc) documents.push(doc);
        if (!lastEditedTime || page.last_edited_time > lastEditedTime) {
          lastEditedTime = page.last_edited_time;
        }
      }

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastEditedTime,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async *syncPage(
    pageId: string,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    this.log.debug({ pageId }, "Syncing Notion page");

    let page: NotionPage;
    try {
      await this.rateLimit();
      page = (await this.notionFetch(
        `/pages/${pageId}`,
        credentials,
      )) as NotionPage;
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ pageId, error: message }, "Page fetch failed");
      throw error;
    }

    const doc = await this.pageToDocument(page, credentials);

    yield {
      documents: doc ? [doc] : [],
      failures: this.flushFailures(),
      checkpoint: buildCheckpoint({
        type: "notion",
        itemUpdatedAt: page.last_edited_time,
        previousLastSyncedAt: checkpoint.lastSyncedAt,
      }),
      hasMore: false,
    };
  }

  private async pageToDocument(
    page: NotionPage,
    credentials: ConnectorCredentials,
  ): Promise<ConnectorDocument | null> {
    const title = extractNotionTitle(page);
    const url =
      page.url ?? `https://notion.so/${page.id.replace(/-/g, "")}`;

    const content = await this.fetchBlockContent(page.id, credentials, 0);

    return {
      id: `notion:${page.id}`,
      title: title || `Notion Page (${page.id})`,
      content,
      sourceUrl: url,
      metadata: {
        kind: "page",
        pageId: page.id,
        lastEditedTime: page.last_edited_time,
        createdTime: page.created_time,
      },
      updatedAt: parseNotionTimestamp(page.last_edited_time),
    };
  }

  private async fetchBlockContent(
    blockId: string,
    credentials: ConnectorCredentials,
    depth: number,
  ): Promise<string> {
    if (depth >= BLOCK_DEPTH_LIMIT) {
      return "";
    }

    await this.rateLimit();

    let response: NotionPaginatedResponse<NotionBlock>;
    try {
      response = (await this.notionFetch(
        `/blocks/${blockId}/children`,
        credentials,
        {
          method: "GET",
          query: { page_size: 100 },
        },
      )) as NotionPaginatedResponse<NotionBlock>;
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.warn(
        { blockId, error: message },
        "Failed to fetch block children, skipping",
      );
      return "";
    }

    const blocks = response.results ?? [];
    const lines: string[] = [];

    for (const block of blocks) {
      const text = blockToMarkdown(block);
      if (text) lines.push(text);

      if (
        block.has_children === true &&
        depth + 1 < BLOCK_DEPTH_LIMIT
      ) {
        await this.rateLimit();
        const children = await this.fetchBlockContent(
          block.id,
          credentials,
          depth + 1,
        );
        if (children) lines.push(children);
      }
    }

    return lines.join("\n");
  }

  private async notionFetch(
    path: string,
    credentials: ConnectorCredentials,
    options: RequestInit & { query?: Record<string, string | number> } = {},
  ): Promise<unknown> {
    let url = `${NOTION_API_BASE}${path}`;
    const query = options.query;
    if (query) {
      const qs = new URLSearchParams(
        Object.fromEntries(
          Object.entries(query).map(([k, v]) => [k, String(v)]),
        ),
      ).toString();
      url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.apiToken}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...options.headers, ...headers },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Notion API ${response.status}: ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ===== Module-level helpers =====

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}

function buildDefaultCheckpoint(): NotionCheckpoint {
  return { type: "notion", lastSyncedAt: undefined };
}

function extractNotionTitle(page: NotionPage): string {
  const titleProp =
    page.properties?.["title"] ?? page.properties?.["Name"];
  if (!titleProp) return "";
  if (titleProp.type === "title") {
    return titleProp.title.map((t) => t.plain_text).join("") ?? "";
  }
  return "";
}

function parseNotionTimestamp(ts: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function blockToMarkdown(block: NotionBlock): string {
  const text = extractBlockText(block);
  if (!text) return "";

  switch (block.type) {
    case "heading_1":
      return `## ${text}`;
    case "heading_2":
      return `### ${text}`;
    case "heading_3":
      return `#### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`${block.code?.language ?? ""}\n${text}\n\`\`\``;
    case "callout":
      return `> **Callout**: ${text}`;
    case "divider":
      return "---";
    case "to_do":
      return `${block.to_do?.checked ? "✅" : "⬜"} ${text}`;
    default:
      return text;
  }
}

function extractBlockText(block: NotionBlock): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const richText = (block as any)[block.type]?.rich_text;
  if (!Array.isArray(richText)) return "";
  return richText.map((t: { plain_text: string }) => t.plain_text).join("");
}

// ===== Notion API types =====

interface NotionPaginatedResponse<T> {
  object: "list";
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  type: string;
}

interface NotionPage {
  id: string;
  object: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
