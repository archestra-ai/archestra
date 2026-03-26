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
const NOTION_VERSION = "2022-06-28";
const BATCH_SIZE = 100;
const MAX_BLOCK_DEPTH = 3;

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

    this.log.info("Testing Notion connection");

    try {
      const response = await this.fetchWithRetry(
        `${NOTION_API_BASE}/search`,
        {
          method: "POST",
          headers: buildHeaders(params.credentials.apiToken),
          body: JSON.stringify({ page_size: 1 }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        this.log.error(
          { status: response.status, body },
          "Connection test failed",
        );
        return {
          success: false,
          error: `Connection failed: HTTP ${response.status}`,
        };
      }

      this.log.info("Connection test successful");
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

    const checkpoint = (params.checkpoint as NotionCheckpoint | null) ?? {
      type: "notion" as const,
    };

    this.log.info(
      {
        databaseIds: parsed.databaseIds,
        pageIds: parsed.pageIds,
        lastSyncedAt: checkpoint.lastSyncedAt,
      },
      "Starting Notion sync",
    );

    const token = params.credentials.apiToken;

    if (parsed.pageIds && parsed.pageIds.length > 0) {
      yield* this.syncByPageIds(parsed.pageIds, token, checkpoint);
    } else if (parsed.databaseIds && parsed.databaseIds.length > 0) {
      yield* this.syncByDatabaseIds(parsed.databaseIds, token, checkpoint);
    } else {
      yield* this.syncWorkspace(token, checkpoint);
    }
  }

  // ===== Private sync methods =====

  private async *syncByPageIds(
    pageIds: string[],
    token: string,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const documents: ConnectorDocument[] = [];

    for (const pageId of pageIds) {
      await this.rateLimit();
      const doc = await this.safeItemFetch({
        fetch: () => this.fetchPage(pageId, token),
        fallback: null,
        itemId: pageId,
        resource: "page",
      });
      if (doc) documents.push(doc);
    }

    yield {
      documents,
      failures: this.flushFailures(),
      checkpoint: buildCheckpoint({
        type: "notion",
        itemUpdatedAt: documents[documents.length - 1]?.updatedAt,
        previousLastSyncedAt: checkpoint.lastSyncedAt,
      }),
      hasMore: false,
    };
  }

  private async *syncByDatabaseIds(
    databaseIds: string[],
    token: string,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    for (const dbId of databaseIds) {
      let cursor: string | undefined;
      let hasMore = true;
      let batchIndex = 0;

      while (hasMore) {
        await this.rateLimit();

        const filter = buildLastEditedFilter(checkpoint.lastSyncedAt);
        // biome-ignore lint/suspicious/noExplicitAny: Notion API response
        const body: Record<string, any> = {
          page_size: BATCH_SIZE,
          sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        };
        if (filter) body.filter = filter;
        if (cursor) body.start_cursor = cursor;

        const response = await this.fetchWithRetry(
          `${NOTION_API_BASE}/databases/${dbId}/query`,
          {
            method: "POST",
            headers: buildHeaders(token),
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          const text = await response.text();
          this.log.error(
            { dbId, status: response.status, body: text },
            "Database query failed",
          );
          break;
        }

        const data = await response.json();
        const results = data.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of results) {
          const doc = await this.safeItemFetch({
            fetch: () => this.pageObjectToDocument(page, token),
            fallback: null,
            itemId: page.id,
            resource: "page_blocks",
          });
          if (doc) documents.push(doc);
          await this.rateLimit();
        }

        cursor = data.next_cursor ?? undefined;
        hasMore = data.has_more === true && !!cursor;

        this.log.info(
          { dbId, batchIndex, pageCount: results.length, hasMore },
          "Database batch fetched",
        );
        batchIndex++;

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt:
              documents[documents.length - 1]?.updatedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore,
        };
      }
    }
  }

  private async *syncWorkspace(
    token: string,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    let cursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      // biome-ignore lint/suspicious/noExplicitAny: Notion API response
      const body: Record<string, any> = {
        filter: { value: "page", property: "object" },
        page_size: BATCH_SIZE,
        sort: { direction: "ascending", timestamp: "last_edited_time" },
      };
      if (cursor) body.start_cursor = cursor;
      if (checkpoint.lastSyncedAt) {
        // Notion search doesn't support date filtering natively; we rely on
        // ascending sort + checkpoint skipping in post-processing.
      }

      const response = await this.fetchWithRetry(`${NOTION_API_BASE}/search`, {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        this.log.error(
          { status: response.status, body: text },
          "Workspace search failed",
        );
        break;
      }

      const data = await response.json();
      const results = data.results ?? [];
      const documents: ConnectorDocument[] = [];

      for (const page of results) {
        if (
          checkpoint.lastSyncedAt &&
          page.last_edited_time <= checkpoint.lastSyncedAt
        ) {
          continue;
        }

        const doc = await this.safeItemFetch({
          fetch: () => this.pageObjectToDocument(page, token),
          fallback: null,
          itemId: page.id,
          resource: "page_blocks",
        });
        if (doc) documents.push(doc);
        await this.rateLimit();
      }

      cursor = data.next_cursor ?? undefined;
      hasMore = data.has_more === true && !!cursor;

      this.log.info(
        { batchIndex, pageCount: results.length, documentCount: documents.length, hasMore },
        "Workspace batch fetched",
      );
      batchIndex++;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: documents[documents.length - 1]?.updatedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  // ===== Private fetch helpers =====

  private async fetchPage(
    pageId: string,
    token: string,
  ): Promise<ConnectorDocument> {
    const response = await this.fetchWithRetry(
      `${NOTION_API_BASE}/pages/${pageId}`,
      { method: "GET", headers: buildHeaders(token) },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch page ${pageId}: HTTP ${response.status}`);
    }

    const page = await response.json();
    return this.pageObjectToDocument(page, token);
  }

  private async pageObjectToDocument(
    // biome-ignore lint/suspicious/noExplicitAny: Notion API page object
    page: any,
    token: string,
  ): Promise<ConnectorDocument> {
    const title = extractPageTitle(page);
    const blocks = await this.fetchBlocksRecursive(page.id, token, 0);
    const content = `# ${title}\n\n${blocksToMarkdown(blocks)}`;
    const sourceUrl = page.url ?? undefined;

    return {
      id: page.id,
      title,
      content,
      sourceUrl,
      metadata: {
        pageId: page.id,
        objectType: page.object,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
        archived: page.archived ?? false,
        parentType: page.parent?.type,
        databaseId:
          page.parent?.type === "database_id"
            ? page.parent.database_id
            : undefined,
      },
      updatedAt: page.last_edited_time
        ? new Date(page.last_edited_time)
        : undefined,
    };
  }

  private async fetchBlocksRecursive(
    blockId: string,
    token: string,
    depth: number,
  // biome-ignore lint/suspicious/noExplicitAny: Notion block objects
  ): Promise<any[]> {
    if (depth >= MAX_BLOCK_DEPTH) return [];

    // biome-ignore lint/suspicious/noExplicitAny: Notion block objects
    const blocks: any[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const url = cursor
        ? `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
        : `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100`;

      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: buildHeaders(token),
      });

      if (!response.ok) {
        this.log.warn(
          { blockId, status: response.status, depth },
          "Failed to fetch block children",
        );
        break;
      }

      const data = await response.json();
      const results = data.results ?? [];

      for (const block of results) {
        if (block.has_children && depth + 1 < MAX_BLOCK_DEPTH) {
          await this.rateLimit();
          block._children = await this.fetchBlocksRecursive(
            block.id,
            token,
            depth + 1,
          );
        }
        blocks.push(block);
      }

      cursor = data.next_cursor ?? undefined;
      hasMore = data.has_more === true && !!cursor;
    }

    return blocks;
  }
}

// ===== Module-level helpers =====

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function buildLastEditedFilter(
  lastSyncedAt: string | undefined,
// biome-ignore lint/suspicious/noExplicitAny: Notion filter object
): any | undefined {
  if (!lastSyncedAt) return undefined;
  return {
    timestamp: "last_edited_time",
    last_edited_time: { on_or_after: lastSyncedAt },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Notion API page object
function extractPageTitle(page: any): string {
  // Pages in a database have a "Name" or "title" property
  const props = page.properties ?? {};
  for (const prop of Object.values(props) as any[]) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title
        .map((t: any) => t.plain_text ?? "")
        .join("");
      if (text) return text;
    }
  }
  // Standalone pages store title under page-level title block
  return page.id;
}

// biome-ignore lint/suspicious/noExplicitAny: Notion block objects
function blocksToMarkdown(blocks: any[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const block of blocks) {
    const line = blockToMarkdownLine(block, indent);
    if (line !== null) lines.push(line);

    if (block._children && block._children.length > 0) {
      lines.push(blocksToMarkdown(block._children, depth + 1));
    }
  }

  return lines.filter((l) => l !== "").join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: Notion block object
function blockToMarkdownLine(block: any, indent: string): string | null {
  const type: string = block.type;
  // biome-ignore lint/suspicious/noExplicitAny: Notion rich text array
  const data: any = block[type] ?? {};

  const richText = (arr: any[]): string =>
    (arr ?? []).map((t: any) => t.plain_text ?? "").join("");

  switch (type) {
    case "paragraph":
      return `${indent}${richText(data.rich_text)}`;
    case "heading_1":
      return `${indent}# ${richText(data.rich_text)}`;
    case "heading_2":
      return `${indent}## ${richText(data.rich_text)}`;
    case "heading_3":
      return `${indent}### ${richText(data.rich_text)}`;
    case "bulleted_list_item":
      return `${indent}- ${richText(data.rich_text)}`;
    case "numbered_list_item":
      return `${indent}1. ${richText(data.rich_text)}`;
    case "to_do":
      return `${indent}- [${data.checked ? "x" : " "}] ${richText(data.rich_text)}`;
    case "toggle":
      return `${indent}${richText(data.rich_text)}`;
    case "quote":
      return `${indent}> ${richText(data.rich_text)}`;
    case "callout":
      return `${indent}> ${richText(data.rich_text)}`;
    case "code":
      return `\`\`\`${data.language ?? ""}\n${richText(data.rich_text)}\n\`\`\``;
    case "divider":
      return `${indent}---`;
    case "table_row": {
      const cells: string[] = (data.cells ?? []).map((cell: any[]) =>
        richText(cell),
      );
      return `${indent}| ${cells.join(" | ")} |`;
    }
    case "child_page":
      return `${indent}[${data.title ?? ""}]`;
    case "child_database":
      return `${indent}[Database: ${data.title ?? ""}]`;
    case "embed":
    case "bookmark":
      return data.url ? `${indent}${data.url}` : null;
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const urlSource =
        data.type === "external" ? data.external?.url : data.file?.url;
      return urlSource ? `${indent}![](${urlSource})` : null;
    }
    case "equation":
      return data.expression ? `${indent}$${data.expression}$` : null;
    case "unsupported":
      return null;
    default:
      return null;
  }
}
