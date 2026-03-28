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

const NOTION_API_VERSION = "2022-06-28";
const NOTION_BASE_URL = "https://api.notion.com/v1";
const SEARCH_PAGE_SIZE = 100;
const MAX_BLOCK_DEPTH = 3;

/**
 * Notion knowledge connector that syncs pages from a Notion workspace
 * using the official REST API (no third-party SDK dependency).
 *
 * Supports three sync modes:
 * 1. Full-workspace via /search API — discovers all accessible pages
 * 2. Filtered by databaseIds — queries specific databases
 * 3. Targeted by pageIds — fetches only specified pages
 *
 * Incremental sync uses lastSyncedAt checkpoint. Block content is fetched
 * recursively up to 3 levels deep and converted to Markdown.
 */
export class NotionConnector extends BaseConnector {
  type = "notion" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseNotionConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error: "Invalid Notion configuration",
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

    this.log.debug("Testing Notion connection");

    try {
      const response = await this.fetchWithRetry(
        `${NOTION_BASE_URL}/users/me`,
        { headers: buildHeaders(params.credentials.apiToken) },
      );

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

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
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseNotionConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Notion configuration");
    }

    const checkpoint = (params.checkpoint as NotionCheckpoint | null) ?? {
      type: "notion" as const,
    };
    const token = params.credentials.apiToken;
    const headers = buildHeaders(token);

    this.log.debug(
      {
        databaseIds: parsed.databaseIds,
        pageIds: parsed.pageIds,
        checkpoint,
      },
      "Starting Notion sync",
    );

    // Mode 1: Specific page IDs — fetch each page directly
    if (parsed.pageIds && parsed.pageIds.length > 0) {
      yield* this.syncSpecificPages(parsed.pageIds, headers, checkpoint);
      return;
    }

    // Mode 2: Specific database IDs — query each database
    if (parsed.databaseIds && parsed.databaseIds.length > 0) {
      yield* this.syncDatabases(parsed.databaseIds, headers, checkpoint);
      return;
    }

    // Mode 3: Full workspace search
    yield* this.syncViaSearch(headers, checkpoint);
  }

  private async *syncSpecificPages(
    pageIds: string[],
    headers: Record<string, string>,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const documents: ConnectorDocument[] = [];

    for (const pageId of pageIds) {
      await this.rateLimit();

      try {
        const page = await this.fetchPage(pageId, headers);
        if (!page) {
          this.log.warn({ pageId }, "Page not found, skipping");
          continue;
        }

        const content = await this.safeItemFetch({
          fetch: () => this.fetchPageContent(pageId, headers),
          fallback: "",
          itemId: pageId,
          resource: "blocks",
        });

        const doc = pageToDocument(page, content);
        documents.push(doc);
      } catch (error) {
        this.log.warn(
          { pageId, error: extractErrorMessage(error) },
          "Failed to fetch page, skipping",
        );
      }
    }

    const lastDoc = documents[documents.length - 1];
    yield {
      documents,
      failures: this.flushFailures(),
      checkpoint: buildCheckpoint({
        type: "notion",
        itemUpdatedAt: lastDoc?.updatedAt,
        previousLastSyncedAt: checkpoint.lastSyncedAt,
      }),
      hasMore: false,
    };
  }

  private async *syncDatabases(
    databaseIds: string[],
    headers: Record<string, string>,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    for (let dbIdx = 0; dbIdx < databaseIds.length; dbIdx++) {
      const databaseId = databaseIds[dbIdx];
      let hasMore = true;
      let startCursor: string | undefined;

      while (hasMore) {
        await this.rateLimit();

        const body: Record<string, unknown> = {
          page_size: SEARCH_PAGE_SIZE,
        };
        if (startCursor) {
          body.start_cursor = startCursor;
        }
        if (checkpoint.lastSyncedAt) {
          body.filter = {
            timestamp: "last_edited_time",
            last_edited_time: { on_or_after: checkpoint.lastSyncedAt },
          };
          body.sorts = [
            { timestamp: "last_edited_time", direction: "ascending" },
          ];
        }

        const response = await this.fetchWithRetry(
          `${NOTION_BASE_URL}/databases/${databaseId}/query`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          this.log.error(
            { databaseId, status: response.status },
            "Database query failed",
          );
          throw new Error(
            `Notion API error: HTTP ${response.status} querying database ${databaseId}`,
          );
        }

        // biome-ignore lint/suspicious/noExplicitAny: Notion API response
        const data = (await response.json()) as any;
        const results = data.results ?? [];
        hasMore = data.has_more ?? false;
        startCursor = data.next_cursor ?? undefined;

        const documents: ConnectorDocument[] = [];
        for (const page of results) {
          if (page.object !== "page") continue;

          const content = await this.safeItemFetch({
            fetch: () => this.fetchPageContent(page.id, headers),
            fallback: "",
            itemId: page.id,
            resource: "blocks",
          });

          documents.push(pageToDocument(page, content));
          await this.rateLimit();
        }

        const lastPage = results[results.length - 1];
        const isLast = !hasMore && dbIdx === databaseIds.length - 1;

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastPage?.last_edited_time,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: !isLast,
        };
      }
    }
  }

  private async *syncViaSearch(
    headers: Record<string, string>,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        page_size: SEARCH_PAGE_SIZE,
      };
      if (startCursor) {
        body.start_cursor = startCursor;
      }
      if (checkpoint.lastSyncedAt) {
        body.sort = {
          direction: "ascending",
          timestamp: "last_edited_time",
        };
      }

      const response = await this.fetchWithRetry(
        `${NOTION_BASE_URL}/search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Notion search failed: HTTP ${response.status} ${text.slice(0, 200)}`);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Notion API response
      const data = (await response.json()) as any;
      const results = (data.results ?? []).filter(
        // biome-ignore lint/suspicious/noExplicitAny: Notion API page objects
        (r: any) => r.object === "page",
      );
      hasMore = data.has_more ?? false;
      startCursor = data.next_cursor ?? undefined;

      // For incremental sync, skip pages not updated since last sync
      const filteredResults = checkpoint.lastSyncedAt
        ? results.filter(
            // biome-ignore lint/suspicious/noExplicitAny: Notion API page objects
            (page: any) =>
              new Date(page.last_edited_time) >=
              new Date(checkpoint.lastSyncedAt as string),
          )
        : results;

      const documents: ConnectorDocument[] = [];
      for (const page of filteredResults) {
        const content = await this.safeItemFetch({
          fetch: () => this.fetchPageContent(page.id, headers),
          fallback: "",
          itemId: page.id,
          resource: "blocks",
        });

        documents.push(pageToDocument(page, content));
        await this.rateLimit();
      }

      const lastPage = filteredResults[filteredResults.length - 1];

      this.log.debug(
        {
          resultCount: results.length,
          filteredCount: filteredResults.length,
          documentCount: documents.length,
          hasMore,
        },
        "Search batch fetched",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastPage?.last_edited_time,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async fetchPage(
    pageId: string,
    headers: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: Notion API response
  ): Promise<any | null> {
    const response = await this.fetchWithRetry(
      `${NOTION_BASE_URL}/pages/${pageId}`,
      { headers },
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch page ${pageId}: HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Fetch all block children for a page, recursively up to MAX_BLOCK_DEPTH
   * levels, and convert to Markdown.
   */
  private async fetchPageContent(
    blockId: string,
    headers: Record<string, string>,
    depth = 0,
  ): Promise<string> {
    if (depth >= MAX_BLOCK_DEPTH) return "";

    const blocks = await this.fetchAllBlocks(blockId, headers);
    const parts: string[] = [];

    for (const block of blocks) {
      const md = blockToMarkdown(block);
      if (md) parts.push(md);

      // Recurse into children if the block has them
      if (block.has_children) {
        const childContent = await this.fetchPageContent(
          block.id,
          headers,
          depth + 1,
        );
        if (childContent) {
          // Indent children for list items
          const indented = childContent
            .split("\n")
            .map((line: string) => (line ? `  ${line}` : line))
            .join("\n");
          parts.push(indented);
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Fetch all block children with pagination.
   */
  private async fetchAllBlocks(
    blockId: string,
    headers: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: Notion block objects
  ): Promise<any[]> {
    // biome-ignore lint/suspicious/noExplicitAny: Notion block objects
    const allBlocks: any[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const url = new URL(
        `${NOTION_BASE_URL}/blocks/${blockId}/children`,
      );
      url.searchParams.set("page_size", "100");
      if (startCursor) {
        url.searchParams.set("start_cursor", startCursor);
      }

      const response = await this.fetchWithRetry(url.toString(), {
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch blocks for ${blockId}: HTTP ${response.status}`,
        );
      }

      // biome-ignore lint/suspicious/noExplicitAny: Notion API response
      const data = (await response.json()) as any;
      allBlocks.push(...(data.results ?? []));
      hasMore = data.has_more ?? false;
      startCursor = data.next_cursor ?? undefined;

      if (hasMore) await this.rateLimit();
    }

    return allBlocks;
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
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Extract a human-readable title from a Notion page object.
 * Notion stores titles in the `properties` object; the exact key name varies.
 */
// biome-ignore lint/suspicious/noExplicitAny: Notion API page object
function extractTitle(page: any): string {
  const props = page.properties ?? {};

  // Look for a property of type "title"
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title
        // biome-ignore lint/suspicious/noExplicitAny: Notion rich text objects
        .map((t: any) => t.plain_text ?? "")
        .join("");
      if (text) return text;
    }
  }

  // Fallback: try page title in child_page blocks or use ID
  return page.id;
}

/**
 * Convert a Notion page to a ConnectorDocument.
 */
// biome-ignore lint/suspicious/noExplicitAny: Notion API page object
function pageToDocument(page: any, content: string): ConnectorDocument {
  const title = extractTitle(page);
  const sourceUrl = page.url ?? undefined;

  return {
    id: page.id,
    title,
    content: content ? `# ${title}\n\n${content}` : `# ${title}`,
    sourceUrl,
    metadata: {
      pageId: page.id,
      parentType: page.parent?.type,
      parentId:
        page.parent?.database_id ??
        page.parent?.page_id ??
        page.parent?.workspace,
      createdTime: page.created_time,
      lastEditedTime: page.last_edited_time,
      createdBy: page.created_by?.id,
      lastEditedBy: page.last_edited_by?.id,
    },
    updatedAt: page.last_edited_time
      ? new Date(page.last_edited_time)
      : undefined,
  };
}

/**
 * Convert a single Notion block to Markdown.
 * Handles the most common block types used in Notion pages.
 */
// biome-ignore lint/suspicious/noExplicitAny: Notion block objects
export function blockToMarkdown(block: any): string {
  const type: string = block.type;
  const data = block[type];
  if (!data) return "";

  const text = richTextToPlain(data.rich_text);

  switch (type) {
    case "paragraph":
      return text ? `${text}\n` : "";
    case "heading_1":
      return text ? `# ${text}\n` : "";
    case "heading_2":
      return text ? `## ${text}\n` : "";
    case "heading_3":
      return text ? `### ${text}\n` : "";
    case "bulleted_list_item":
      return text ? `- ${text}` : "";
    case "numbered_list_item":
      return text ? `1. ${text}` : "";
    case "to_do": {
      const checked = data.checked ? "x" : " ";
      return text ? `- [${checked}] ${text}` : "";
    }
    case "toggle":
      return text ? `- ${text}` : "";
    case "quote":
      return text ? `> ${text}\n` : "";
    case "callout":
      return text ? `> ${text}\n` : "";
    case "code": {
      const lang = data.language ?? "";
      return text ? `\`\`\`${lang}\n${text}\n\`\`\`\n` : "";
    }
    case "divider":
      return "---\n";
    case "image": {
      const url = data.file?.url ?? data.external?.url ?? "";
      const caption = richTextToPlain(data.caption);
      return url ? `![${caption || "image"}](${url})\n` : "";
    }
    case "bookmark": {
      const url = data.url ?? "";
      const caption = richTextToPlain(data.caption);
      return url ? `[${caption || url}](${url})\n` : "";
    }
    case "equation":
      return data.expression ? `$$${data.expression}$$\n` : "";
    case "table_of_contents":
      return "";
    case "child_page":
      return data.title ? `**${data.title}**\n` : "";
    case "child_database":
      return data.title ? `**${data.title}**\n` : "";
    case "embed": {
      const url = data.url ?? "";
      return url ? `[Embed: ${url}](${url})\n` : "";
    }
    case "video": {
      const url = data.file?.url ?? data.external?.url ?? "";
      return url ? `[Video: ${url}](${url})\n` : "";
    }
    case "pdf": {
      const url = data.file?.url ?? data.external?.url ?? "";
      return url ? `[PDF: ${url}](${url})\n` : "";
    }
    case "file": {
      const url = data.file?.url ?? data.external?.url ?? "";
      const name = data.name ?? "file";
      return url ? `[${name}](${url})\n` : "";
    }
    case "audio": {
      const url = data.file?.url ?? data.external?.url ?? "";
      return url ? `[Audio: ${url}](${url})\n` : "";
    }
    default:
      // Unsupported block types: return text content if available
      return text ? `${text}\n` : "";
  }
}

/**
 * Convert Notion rich text array to plain text.
 */
// biome-ignore lint/suspicious/noExplicitAny: Notion rich text objects
export function richTextToPlain(richText: any[] | undefined): string {
  if (!Array.isArray(richText)) return "";
  // biome-ignore lint/suspicious/noExplicitAny: Notion rich text objects
  return richText.map((t: any) => t.plain_text ?? "").join("");
}
