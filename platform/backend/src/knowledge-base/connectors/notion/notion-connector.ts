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
const DEFAULT_BATCH_SIZE = 100;

export class NotionConnector extends BaseConnector {
  type = "notion" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
    if (!result.success) {
      return {
        valid: false,
        error: `Invalid Notion configuration: ${result.error.message}`,
      };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchNotion("/v1/users/me", params.credentials.apiToken);
      if (!response.ok) {
        const error = await response.json();
        return {
          success: false,
          error: `Connection failed: ${error.message || response.statusText}`,
        };
      }
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
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
    const config = NotionConfigSchema.parse({ type: "notion", ...params.config });
    const checkpoint = (params.checkpoint as NotionCheckpoint | null) ?? {
      type: "notion" as const,
    };
    const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;

    this.log.info({ checkpoint, config }, "Starting Notion sync");

    let hasMore = true;
    let nextCursor: string | undefined;

    while (hasMore) {
      await this.rateLimit();

      const searchBody: any = {
        page_size: batchSize,
        sort: {
          direction: "ascending",
          timestamp: "last_edited_time",
        },
      };

      if (nextCursor) {
        searchBody.start_cursor = nextCursor;
      }

      // If databaseIds or pageIds are specified, we use the specific fetch logic instead of search
      const hasFilters = (config.databaseIds && config.databaseIds.length > 0) || (config.pageIds && config.pageIds.length > 0);
      
      let itemsToProcess = [];
      if (hasFilters && !nextCursor) {
        // Initial filter-based fetch
        if (config.databaseIds) {
          for (const dbId of config.databaseIds) {
            try {
              const res = await this.fetchNotion(`/v1/databases/${dbId}`, params.credentials.apiToken);
              if (res.ok) itemsToProcess.push(await res.json());
            } catch (e) {
              this.log.warn({ dbId, error: extractErrorMessage(e) }, "Failed to fetch database by ID");
            }
          }
        }
        if (config.pageIds) {
          for (const pageId of config.pageIds) {
            try {
              const res = await this.fetchNotion(`/v1/pages/${pageId}`, params.credentials.apiToken);
              if (res.ok) itemsToProcess.push(await res.json());
            } catch (e) {
              this.log.warn({ pageId, error: extractErrorMessage(e) }, "Failed to fetch page by ID");
            }
          }
        }
        hasMore = false; // Filters don't support pagination in this simple loop
      } else if (!hasFilters) {
        const response = await this.fetchNotion("/v1/search", params.credentials.apiToken, {
          method: "POST",
          body: JSON.stringify(searchBody),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(`Notion search failed: ${error.message || response.statusText}`);
        }

        const data = await response.json();
        itemsToProcess = data.results || [];
        hasMore = data.has_more;
        nextCursor = data.next_cursor;
      }

      const documents: ConnectorDocument[] = [];

      for (const result of itemsToProcess) {
        // Skip results older than lastSyncedAt
        if (checkpoint.lastSyncedAt && new Date(result.last_edited_time) <= new Date(checkpoint.lastSyncedAt)) {
          continue;
        }

        if (result.object === "page" || result.object === "database") {
          const doc = await this.processItem(result, params.credentials.apiToken);
          if (doc) {
            documents.push(doc);
          }
        }
      }

      const lastItem = itemsToProcess[itemsToProcess.length - 1];
      const lastSyncedAt = lastItem?.last_edited_time;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastSyncedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async processItem(item: any, token: string): Promise<ConnectorDocument | null> {
    try {
      const title = this.extractTitle(item);
      const content = await this.fetchContent(item.id, token);
      
      return {
        id: item.id,
        title,
        content: `# ${title}\n\n${content}`,
        sourceUrl: item.url,
        updatedAt: new Date(item.last_edited_time),
        metadata: {
          id: item.id,
          object: item.object,
          createdTime: item.created_time,
          lastEditedTime: item.last_edited_time,
          icon: item.icon,
          cover: item.cover,
        },
      };
    } catch (error) {
      this.log.error({ itemId: item.id, error: extractErrorMessage(error) }, "Failed to process Notion item");
      return null;
    }
  }

  private extractTitle(item: any): string {
    if (item.object === "page") {
      const titleProp = Object.values(item.properties || {}).find(
        (prop: any) => prop.type === "title"
      ) as any;
      return titleProp?.title?.map((t: any) => t.plain_text).join("") || "Untitled";
    } else if (item.object === "database") {
      return item.title?.map((t: any) => t.plain_text).join("") || "Untitled Database";
    }
    return "Untitled";
  }

  private async fetchContent(blockId: string, token: string, depth = 0): Promise<string> {
    if (depth > 3) return ""; // Recursion limit

    let markdown = "";
    let hasMore = true;
    let nextCursor: string | undefined;

    while (hasMore) {
      await this.rateLimit();
      const url = `/v1/blocks/${blockId}/children${nextCursor ? `?start_cursor=${nextCursor}` : ""}`;
      const response = await this.fetchNotion(url, token);
      
      if (!response.ok) {
        this.log.warn({ blockId, status: response.status }, "Failed to fetch block children");
        break;
      }

      const data = await response.json();
      for (const block of data.results) {
        markdown += await this.blockToMarkdown(block, token, depth);
      }

      hasMore = data.has_more;
      nextCursor = data.next_cursor;
    }

    return markdown;
  }

  private async blockToMarkdown(block: any, token: string, depth: number): Promise<string> {
    let text = "";
    const type = block.type;
    const content = block[type];

    switch (type) {
      case "paragraph":
        text = this.richTextToMarkdown(content.rich_text) + "\n\n";
        break;
      case "heading_1":
        text = "# " + this.richTextToMarkdown(content.rich_text) + "\n\n";
        break;
      case "heading_2":
        text = "## " + this.richTextToMarkdown(content.rich_text) + "\n\n";
        break;
      case "heading_3":
        text = "### " + this.richTextToMarkdown(content.rich_text) + "\n\n";
        break;
      case "bulleted_list_item":
        text = "* " + this.richTextToMarkdown(content.rich_text) + "\n";
        break;
      case "numbered_list_item":
        text = "1. " + this.richTextToMarkdown(content.rich_text) + "\n";
        break;
      case "to_do":
        text = (content.checked ? "- [x] " : "- [ ] ") + this.richTextToMarkdown(content.rich_text) + "\n";
        break;
      case "toggle":
        text = "> " + this.richTextToMarkdown(content.rich_text) + "\n";
        break;
      case "code":
        text = "```" + content.language + "\n" + this.richTextToMarkdown(content.rich_text) + "\n```\n\n";
        break;
      case "quote":
        text = "> " + this.richTextToMarkdown(content.rich_text) + "\n\n";
        break;
      case "divider":
        text = "---\n\n";
        break;
      case "callout":
        text = "> " + (content.icon?.emoji || "") + " " + this.richTextToMarkdown(content.rich_text) + "\n\n";
        break;
      // Add more types as needed
    }

    if (block.has_children) {
      const childrenMarkdown = await this.fetchContent(block.id, token, depth + 1);
      text += childrenMarkdown;
    }

    return text;
  }

  private richTextToMarkdown(richText: any[]): string {
    return richText.map((rt: any) => {
      let text = rt.plain_text;
      if (rt.annotations.bold) text = `**${text}**`;
      if (rt.annotations.italic) text = `*${text}*`;
      if (rt.annotations.strikethrough) text = `~~${text}~~`;
      if (rt.annotations.code) text = `\`${text}\``;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    }).join("");
  }

  private async fetchNotion(path: string, token: string, options: RequestInit = {}): Promise<Response> {
    const url = `https://api.notion.com${path}`;
    return this.fetchWithRetry(url, {
      ...options,
      headers: {
        ...options.headers,
        "Authorization": `Bearer ${token}`,
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
      },
    });
  }
}
