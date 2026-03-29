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
  REQUEST_TIMEOUT_MS,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 100;
const NOTION_API_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";
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
          "Invalid Notion configuration: at least one of parentPageIds or databaseIds is recommended",
      };
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
          headers: buildHeaders(params.credentials.apiToken),
        },
      );
      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `Notion API returned ${response.status}: ${body}`,
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

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseNotionConfig(params.config);
    if (!parsed) return null;

    try {
      const response = await this.fetchWithRetry(
        `${NOTION_API_BASE}/search`,
        {
          method: "POST",
          headers: buildHeaders(params.credentials.apiToken),
          body: JSON.stringify({
            filter: { property: "object", value: "page" },
            page_size: 1,
          }),
        },
      );
      if (!response.ok) return null;
      // Notion search API doesn't return total count; return null
      return null;
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
    const parsed = parseNotionConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Notion configuration");
    }

    const checkpoint =
      (params.checkpoint as NotionCheckpoint | null) ?? {
        type: "notion" as const,
      };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const token = params.credentials.apiToken;

    this.log.debug(
      {
        parentPageIds: parsed.parentPageIds,
        databaseIds: parsed.databaseIds,
        checkpoint,
      },
      "Starting Notion sync",
    );

    // Strategy: use Notion Search API to find all pages the integration can access
    let startCursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, startCursor }, "Fetching batch");

        const searchBody: Record<string, unknown> = {
          filter: { property: "object", value: "page" },
          page_size: batchSize,
          sort: {
            direction: "ascending",
            timestamp: "last_edited_time",
          },
        };
        if (startCursor) {
          searchBody.start_cursor = startCursor;
        }

        // Filter by last_edited_time if we have a checkpoint
        if (checkpoint.lastSyncedAt) {
          searchBody.filter = {
            property: "object",
            value: "page",
          };
        }

        const response = await this.fetchWithRetry(
          `${NOTION_API_BASE}/search`,
          {
            method: "POST",
            headers: buildHeaders(token),
            body: JSON.stringify(searchBody),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Notion search failed (${response.status}): ${body}`);
        }

        const data = (await response.json()) as NotionSearchResponse;
        const pages = data.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of pages) {
          // Skip pages older than checkpoint
          if (
            checkpoint.lastSyncedAt &&
            page.last_edited_time < checkpoint.lastSyncedAt
          ) {
            continue;
          }

          // Filter by parentPageIds if specified
          if (parsed.parentPageIds && parsed.parentPageIds.length > 0) {
            const parentId = getParentId(page);
            if (parentId && !parsed.parentPageIds.includes(parentId)) {
              continue;
            }
          }

          // Filter by databaseIds if specified
          if (parsed.databaseIds && parsed.databaseIds.length > 0) {
            if (
              page.parent?.type === "database_id" &&
              !parsed.databaseIds.includes(page.parent.database_id)
            ) {
              continue;
            }
          }

          const content = await this.safeItemFetch({
            fetch: () => this.fetchPageContent(token, page.id),
            fallback: "",
            itemId: page.id,
            resource: "blocks",
          });

          const title = extractTitle(page);
          const sourceUrl = page.url;

          documents.push({
            id: page.id,
            title,
            content: `# ${title}\n\n${content}`,
            sourceUrl,
            metadata: {
              pageId: page.id,
              parentType: page.parent?.type,
              parentId: getParentId(page),
              createdTime: page.created_time,
              lastEditedTime: page.last_edited_time,
              createdBy: page.created_by?.id,
              lastEditedBy: page.last_edited_by?.id,
            },
            updatedAt: page.last_edited_time
              ? new Date(page.last_edited_time)
              : undefined,
          });
        }

        startCursor = data.next_cursor ?? undefined;
        hasMore = data.has_more && !!startCursor;

        const lastPage = pages[pages.length - 1];

        this.log.debug(
          {
            batchIndex,
            pageCount: pages.length,
            documentCount: documents.length,
            hasMore,
          },
          "Batch fetched",
        );

        batchIndex++;

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastPage?.last_edited_time,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: {
              lastPageId: lastPage?.id ?? checkpoint.lastPageId,
              lastCursor: startCursor,
            },
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "Batch fetch failed",
        );
        throw error;
      }
    }
  }

  /**
   * Fetch all block children for a page, recursively up to MAX_BLOCK_DEPTH levels,
   * and convert to Markdown.
   */
  private async fetchPageContent(
    token: string,
    blockId: string,
    depth = 0,
  ): Promise<string> {
    if (depth >= MAX_BLOCK_DEPTH) return "";

    const blocks: NotionBlock[] = [];
    let startCursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      const url = new URL(
        `${NOTION_API_BASE}/blocks/${blockId}/children`,
      );
      url.searchParams.set("page_size", "100");
      if (startCursor) {
        url.searchParams.set("start_cursor", startCursor);
      }

      const response = await this.fetchWithRetry(url.toString(), {
        headers: buildHeaders(token),
      });

      if (!response.ok) {
        this.log.warn(
          { blockId, status: response.status },
          "Failed to fetch block children",
        );
        break;
      }

      const data = (await response.json()) as {
        results: NotionBlock[];
        has_more: boolean;
        next_cursor: string | null;
      };

      blocks.push(...data.results);
      startCursor = data.next_cursor ?? undefined;
      hasMore = data.has_more && !!startCursor;
    }

    const parts: string[] = [];

    for (const block of blocks) {
      const text = blockToMarkdown(block);
      if (text) {
        parts.push(text);
      }

      // Recurse into children if the block has them
      if (block.has_children && depth < MAX_BLOCK_DEPTH - 1) {
        const childContent = await this.fetchPageContent(
          token,
          block.id,
          depth + 1,
        );
        if (childContent) {
          // Indent child content for nested blocks
          const indented = childContent
            .split("\n")
            .map((line) => (line ? `  ${line}` : line))
            .join("\n");
          parts.push(indented);
        }
      }
    }

    return parts.join("\n");
  }
}

// ===== Types =====

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionPage {
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  created_by?: { id: string };
  last_edited_by?: { id: string };
  parent?: {
    type: string;
    page_id?: string;
    database_id?: string;
    workspace?: boolean;
  };
  properties?: Record<string, NotionProperty>;
}

interface NotionProperty {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
}

interface NotionRichText {
  type: string;
  plain_text: string;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
  href?: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

// ===== Helpers =====

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({
    type: "notion",
    ...config,
  });
  return result.success ? result.data : null;
}

function extractTitle(page: NotionPage): string {
  if (!page.properties) return "Untitled";
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title) {
      return prop.title.map((t) => t.plain_text).join("") || "Untitled";
    }
  }
  return "Untitled";
}

function getParentId(page: NotionPage): string | undefined {
  if (!page.parent) return undefined;
  switch (page.parent.type) {
    case "page_id":
      return page.parent.page_id;
    case "database_id":
      return page.parent.database_id;
    default:
      return undefined;
  }
}

/**
 * Convert a Notion block to Markdown.
 * Handles headings, paragraphs, bullets, quotes, code blocks, etc.
 */
function blockToMarkdown(block: NotionBlock): string {
  const type = block.type;
  // biome-ignore lint/suspicious/noExplicitAny: Notion block shapes vary
  const data = (block as any)[type];
  if (!data) return "";

  switch (type) {
    case "paragraph":
      return richTextToMarkdown(data.rich_text) + "\n";
    case "heading_1":
      return `# ${richTextToMarkdown(data.rich_text)}\n`;
    case "heading_2":
      return `## ${richTextToMarkdown(data.rich_text)}\n`;
    case "heading_3":
      return `### ${richTextToMarkdown(data.rich_text)}\n`;
    case "bulleted_list_item":
      return `- ${richTextToMarkdown(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToMarkdown(data.rich_text)}`;
    case "to_do": {
      const checked = data.checked ? "x" : " ";
      return `- [${checked}] ${richTextToMarkdown(data.rich_text)}`;
    }
    case "toggle":
      return richTextToMarkdown(data.rich_text);
    case "quote":
      return `> ${richTextToMarkdown(data.rich_text)}\n`;
    case "callout":
      return `> ${data.icon?.emoji ?? ""} ${richTextToMarkdown(data.rich_text)}\n`;
    case "code": {
      const lang = data.language ?? "";
      const code = richTextToMarkdown(data.rich_text);
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case "divider":
      return "---\n";
    case "table_of_contents":
      return "";
    case "breadcrumb":
      return "";
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const url =
        data.external?.url ?? data.file?.url ?? "";
      const caption = data.caption
        ? richTextToMarkdown(data.caption)
        : "";
      return caption ? `[${caption}](${url})\n` : `${url}\n`;
    }
    case "bookmark":
      return data.url ? `[${data.url}](${data.url})\n` : "";
    case "link_preview":
      return data.url ? `[${data.url}](${data.url})\n` : "";
    case "equation":
      return data.expression ? `$$${data.expression}$$\n` : "";
    case "column_list":
    case "column":
    case "synced_block":
    case "template":
      return ""; // Children will be handled recursively
    default:
      // For unknown block types, try to extract rich_text if available
      if (data.rich_text) {
        return richTextToMarkdown(data.rich_text) + "\n";
      }
      return "";
  }
}

function richTextToMarkdown(richText: NotionRichText[] | undefined): string {
  if (!richText || richText.length === 0) return "";
  return richText
    .map((rt) => {
      let text = rt.plain_text;
      if (rt.annotations?.bold) text = `**${text}**`;
      if (rt.annotations?.italic) text = `*${text}*`;
      if (rt.annotations?.strikethrough) text = `~~${text}~~`;
      if (rt.annotations?.code) text = `\`${text}\``;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    })
    .join("");
}
