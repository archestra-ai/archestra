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
const NOTION_VERSION = "2022-06-28";
const BATCH_SIZE = 100;
const MAX_DEPTH = 3;

interface NotionBlock {
  id: string;
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: Notion API response
  [key: string]: any;
}

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
          "Invalid Notion configuration: no additional fields required (authentication is via Integration Token)",
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

    this.log.debug("Testing connection to Notion API");

    try {
      // Search to verify the token is valid and can access content
      const response = await this.fetchNotion("/search", params.credentials, {
        query: "",
        page_size: 1,
        filter: { property: "object", value: "page" },
      });

      if (response.ok) {
        this.log.debug("Connection test successful");
        return { success: true };
      } else {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        this.log.error({ error }, "Connection test failed");
        return {
          success: false,
          error: `Notion API error: ${(error as { message?: string }).message ?? response.status}`,
        };
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(): Promise<number | null> {
    // Notion doesn't provide a total count from search without fetching all results,
    // so we skip estimation
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

    this.log.debug(
      {
        databaseIds: parsed.databaseIds,
        pageIds: parsed.pageIds,
        checkpoint,
      },
      "Starting Notion sync",
    );

    const processedIds = new Set<string>();

    // Step 1: Determine which pages/databases to sync
    const targetPages: string[] = [];

    if (parsed.pageIds && parsed.pageIds.length > 0) {
      // Explicit page IDs
      targetPages.push(...parsed.pageIds);
    } else if (parsed.databaseIds && parsed.databaseIds.length > 0) {
      // Pages from specific databases
      for (const dbId of parsed.databaseIds) {
        const dbPages = await this.fetchDatabasePages(dbId, params.credentials, checkpoint.lastSyncedAt);
        for (const page of dbPages) {
          if (!processedIds.has(page.id)) {
            targetPages.push(page.id);
            processedIds.add(page.id);
          }
        }
      }
    } else {
      // Full workspace search
      const searchPages = await this.searchAllPages(
        params.credentials,
        checkpoint.lastSyncedAt,
      );
      for (const page of searchPages) {
        if (!processedIds.has(page.id)) {
          targetPages.push(page.id);
          processedIds.add(page.id);
        }
      }
    }

    this.log.debug(
      { pageCount: targetPages.length },
      "Found pages to sync",
    );

    // Step 2: Fetch and yield each page as a document
    for (let i = 0; i < targetPages.length; i++) {
      const pageId = targetPages[i];
      await this.rateLimit();

      try {
        const pageResponse = await this.fetchNotion(
          `/pages/${pageId}`,
          params.credentials,
        );

        if (!pageResponse.ok) {
          this.log.warn(
            { pageId, status: pageResponse.status },
            "Failed to fetch page, skipping",
          );
          this.itemFailures.push({
            itemId: pageId,
            resource: "page",
            error: `HTTP ${pageResponse.status}`,
          });
          continue;
        }

        const pageData = await pageResponse.json() as {
          id: string;
          url: string;
          properties?: Record<string, unknown>;
          // biome-ignore lint/suspicious/noExplicitAny: Notion API response
        };

        const title = this.extractPageTitle(pageData.properties ?? {});
        const blocks = await this.fetchBlockChildren(pageId, params.credentials, 0);
        const markdownContent = this.blocksToMarkdown(blocks);

        const lastEdited = pageData.properties?.last_edited_time as string | undefined;

        const document: ConnectorDocument = {
          id: pageId,
          title: title || `Notion Page ${pageId}`,
          content: markdownContent,
          sourceUrl: pageData.url ?? `https://notion.so/${pageId.replace(/-/g, "")}`,
          metadata: {
            kind: "notion_page",
            source: "notion",
          },
          updatedAt: lastEdited ? new Date(lastEdited) : undefined,
        };

        const isLastItem = i === targetPages.length - 1;

        yield {
          documents: [document],
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastEdited,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: !isLastItem,
        };
      } catch (error) {
        const message = extractErrorMessage(error);
        this.log.warn(
          { pageId, error: message },
          "Failed to sync page, skipping",
        );
        this.itemFailures.push({
          itemId: pageId,
          resource: "page",
          error: message,
        });
      }
    }
  }

  // ===== Private helper methods =====

  private async fetchNotion(
    path: string,
    credentials: ConnectorCredentials,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const url = `${NOTION_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.apiToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };

    const options: RequestInit = body
      ? {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }
      : { method: "GET", headers };

    return this.fetchWithRetry(url, options);
  }

  private async searchAllPages(
    credentials: ConnectorCredentials,
    lastSyncedAt?: string,
  ): Promise<Array<{ id: string }>> {
    const pages: Array<{ id: string }> = [];
    let cursor: string | undefined;

    do {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        query: "",
        page_size: BATCH_SIZE,
        filter: { property: "object", value: "page" },
      };

      if (cursor) {
        body.start_cursor = cursor;
      }

      const response = await this.fetchNotion("/search", credentials, body);

      if (!response.ok) {
        this.log.warn(
          { status: response.status },
          "Search API failed, aborting workspace sync",
        );
        break;
      }

      const data = await response.json() as {
        results: Array<{ id: string; last_edited_time?: string }>;
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const result of data.results) {
        // Filter by last_edited_time if we have a checkpoint
        if (lastSyncedAt && result.last_edited_time) {
          if (result.last_edited_time <= lastSyncedAt) {
            continue;
          }
        }
        pages.push({ id: result.id });
      }

      cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
    } while (cursor);

    return pages;
  }

  private async fetchDatabasePages(
    databaseId: string,
    credentials: ConnectorCredentials,
    lastSyncedAt?: string,
  ): Promise<Array<{ id: string; last_edited_time?: string }>> {
    const pages: Array<{ id: string; last_edited_time?: string }> = [];
    let cursor: string | undefined;

    do {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        page_size: BATCH_SIZE,
      };

      if (cursor) {
        body.start_cursor = cursor;
      }

      const response = await this.fetchNotion(
        `/databases/${databaseId}/query`,
        credentials,
        body,
      );

      if (!response.ok) {
        this.log.warn(
          { databaseId, status: response.status },
          "Database query failed, skipping database",
        );
        break;
      }

      const data = await response.json() as {
        results: Array<{ id: string; last_edited_time?: string }>;
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const result of data.results) {
        if (lastSyncedAt && result.last_edited_time) {
          if (result.last_edited_time <= lastSyncedAt) {
            continue;
          }
        }
        pages.push(result);
      }

      cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
    } while (cursor);

    return pages;
  }

  private async fetchBlockChildren(
    blockId: string,
    credentials: ConnectorCredentials,
    depth: number,
  ): Promise<NotionBlock[]> {
    if (depth >= MAX_DEPTH) {
      return [];
    }

    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      await this.rateLimit();

      const path = cursor
        ? `/blocks/${blockId}/children?page_size=${BATCH_SIZE}&start_cursor=${cursor}`
        : `/blocks/${blockId}/children?page_size=${BATCH_SIZE}`;

      const response = await this.fetchNotion(path, credentials);

      if (!response.ok) {
        this.log.warn(
          { blockId, status: response.status },
          "Failed to fetch block children",
        );
        break;
      }

      const data = await response.json() as {
        results: NotionBlock[];
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const block of data.results) {
        blocks.push(block);

        // Recursively fetch children for blocks that have children
        if (block.has_children === true) {
          const children = await this.fetchBlockChildren(
            block.id,
            credentials,
            depth + 1,
          );
          (block as NotionBlock & { children?: NotionBlock[] }).children = children;
        }
      }

      cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
    } while (cursor);

    return blocks;
  }

  private extractPageTitle(
    // biome-ignore lint/suspicious/noExplicitAny: Notion properties structure
    properties: Record<string, any>,
  ): string {
    for (const prop of Object.values(properties)) {
      if (prop.type === "title" && Array.isArray(prop.title) && prop.title.length > 0) {
        return prop.title.map((t: { plain_text?: string; text?: string }) => t.plain_text ?? t.text ?? "").join("");
      }
    }
    return "";
  }

  private blocksToMarkdown(blocks: NotionBlock[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
      const md = this.blockToMarkdown(block, 0);
      if (md) {
        lines.push(md);
      }
    }

    return lines.join("\n");
  }

  private blockToMarkdown(block: NotionBlock, depth: number): string {
    const indent = "  ".repeat(depth);
    const children = (block as NotionBlock & { children?: NotionBlock[] }).children ?? [];

    switch (block.type) {
      case "heading_1":
        return `${indent}# ${this.getBlockText(block.heading_1?.rich_text)}`;

      case "heading_2":
        return `${indent}## ${this.getBlockText(block.heading_2?.rich_text)}`;

      case "heading_3":
        return `${indent}### ${this.getBlockText(block.heading_3?.rich_text)}`;

      case "paragraph":
        return `${indent}${this.getBlockText(block.paragraph?.rich_text)}`;

      case "bulleted_list_item":
        return `${indent}- ${this.getBlockText(block.bulleted_list_item?.rich_text)}`;

      case "numbered_list_item":
        return `${indent}1. ${this.getBlockText(block.numbered_list_item?.rich_text)}`;

      case "to_do":
        const checked = block.to_do?.checked ? "[x]" : "[ ]";
        return `${indent}- ${checked} ${this.getBlockText(block.to_do?.rich_text)}`;

      case "quote":
        return `${indent}> ${this.getBlockText(block.quote?.rich_text)}`;

      case "callout":
        return `${indent}> ${this.getBlockText(block.callout?.rich_text)}`;

      case "code":
        const lang = block.code?.language ?? "";
        const code = this.getBlockText(block.code?.rich_text);
        return `${indent}\`\`\`${lang}\n${code}\n${indent}\`\`\``;

      case "divider":
        return `${indent}---`;

      case "image": {
        const url =
          block.image?.type === "external"
            ? block.image.external?.url
            : block.image?.file?.url;
        const caption = this.getBlockText(block.image?.caption);
        return url ? `${indent}![${caption}](${url})` : "";
      }

      case "video": {
        const videoUrl =
          block.video?.type === "external"
            ? block.video.external?.url
            : block.video?.file?.url;
        const videoCaption = this.getBlockText(block.video?.caption);
        return videoUrl ? `${indent}[${videoCaption}](${videoUrl})` : "";
      }

      case "bookmark":
        return block.bookmark?.url
          ? `${indent}[${block.bookmark?.caption ? this.getBlockText(block.bookmark.caption) : "Link"}](${block.bookmark.url})`
          : "";

      case "embed":
        return block.embed?.url
          ? `${indent}[Embed](${block.embed.url})`
          : "";

      case "table":
        return this.renderTable(block, children, indent);

      case "toggle":
        return `${indent}**Toggle:** ${this.getBlockText(block.toggle?.rich_text)}\n${children.map((c) => this.blockToMarkdown(c, depth + 1)).filter(Boolean).join("\n")}`;

      case "child_database":
      case "child_page":
        // Skip database/page references that are just links
        return "";

      default:
        // Try to render children even if block type is unknown
        if (children.length > 0) {
          return children.map((c) => this.blockToMarkdown(c, depth)).filter(Boolean).join("\n");
        }
        return "";
    }
  }

  private renderTable(block: NotionBlock, children: NotionBlock[], indent: string): string {
    const rows: string[] = [];
    for (const child of children) {
      if (child.type === "table_row") {
        const cells = child.table_row?.cells ?? [];
        const rowStr = cells.map((cell: Array<{ plain_text?: string; text?: string }>) =>
          this.getBlockText(cell).trim(),
        ).join(" | ");
        rows.push(`${indent}| ${rowStr} |`);
      }
    }
    return rows.join("\n");
  }

  private getBlockText(
    // biome-ignore lint/suspicious/noExplicitAny: Notion rich_text array
    richText: any,
  ): string {
    if (!richText || !Array.isArray(richText)) {
      return "";
    }
    return richText
      .map((t: { plain_text?: string; text?: string; type?: string; annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean } }) => {
        let text = t.plain_text ?? t.text ?? "";
        const annotations = t.annotations ?? {};
        if (annotations.bold) text = `**${text}**`;
        if (annotations.italic) text = `*${text}*`;
        if (annotations.strikethrough) text = `~~${text}~~`;
        if (annotations.code) text = `\`${text}\``;
        return text;
      })
      .join("");
  }
}

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}
