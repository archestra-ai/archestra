import {
  KnowledgeConnectorBase,
  SyncResult,
  SyncedDocument,
} from "../base-connector";
import {
  NotionConfig,
  NotionCheckpoint,
} from "../../../types/knowledge-connector";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_BLOCK_DEPTH = 3;

interface NotionPage {
  id: string;
  object: "page" | "database";
  url: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
  parent: NotionParent;
  archived: boolean;
}

interface NotionProperty {
  id: string;
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  [key: string]: unknown;
}

interface NotionParent {
  type: "database_id" | "page_id" | "workspace" | "block_id";
  database_id?: string;
  page_id?: string;
  block_id?: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

export class NotionConnector extends KnowledgeConnectorBase<
  NotionConfig,
  NotionCheckpoint
> {
  private readonly token: string;

  constructor(config: NotionConfig) {
    super(config);
    this.token = config.credentials.integrationToken;
  }

  private async notionRequest<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${NOTION_API_BASE}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Notion API error ${response.status} for ${path}: ${body}`
      );
    }

    return response.json() as Promise<T>;
  }

  async validateConfig(): Promise<void> {
    if (!this.config.credentials?.integrationToken) {
      throw new Error("Notion Integration Token is required");
    }
    const token = this.config.credentials.integrationToken.trim();
    if (!token.startsWith("secret_") && !token.startsWith("ntn_")) {
      throw new Error(
        "Invalid Notion Integration Token format (expected 'secret_...' or 'ntn_...')"
      );
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.validateConfig();
      // A simple search with page_size=1 is the lightest authenticated call
      await this.notionRequest<NotionSearchResponse>("/search", {
        method: "POST",
        body: JSON.stringify({ page_size: 1 }),
      });
      return { success: true, message: "Successfully connected to Notion" };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${(error as Error).message}`,
      };
    }
  }

  async sync(
    checkpoint: NotionCheckpoint | null
  ): Promise<SyncResult<NotionCheckpoint>> {
    await this.validateConfig();

    const syncedAt = new Date().toISOString();
    const documents: SyncedDocument[] = [];
    const errors: string[] = [];

    try {
      const pages = await this.fetchPages(checkpoint?.lastSyncedAt ?? null);

      for (const page of pages) {
        if (page.archived) continue;

        try {
          const doc = await this.pageToDocument(page);
          documents.push(doc);
        } catch (err) {
          errors.push(
            `Failed to sync page ${page.id}: ${(err as Error).message}`
          );
        }
      }
    } catch (err) {
      errors.push(`Failed to fetch pages: ${(err as Error).message}`);
    }

    return {
      documents,
      checkpoint: { lastSyncedAt: syncedAt },
      errors,
    };
  }

  // ---------------------------------------------------------------------------
  // Page fetching
  // ---------------------------------------------------------------------------

  private async fetchPages(lastSyncedAt: string | null): Promise<NotionPage[]> {
    const { pageIds, databaseIds } = this.config;

    // Explicit page list
    if (pageIds && pageIds.length > 0) {
      return this.fetchPagesByIds(pageIds, lastSyncedAt);
    }

    // Filtered by databases
    if (databaseIds && databaseIds.length > 0) {
      return this.fetchPagesByDatabases(databaseIds, lastSyncedAt);
    }

    // Full workspace sync
    return this.fetchAllPages(lastSyncedAt);
  }

  private async fetchPagesByIds(
    ids: string[],
    lastSyncedAt: string | null
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    for (const id of ids) {
      try {
        const page = await this.notionRequest<NotionPage>(
          `/pages/${this.normalizeId(id)}`
        );
        if (
          !lastSyncedAt ||
          new Date(page.last_edited_time) > new Date(lastSyncedAt)
        ) {
          pages.push(page);
        }
      } catch (err) {
        // Non-fatal — page may have been deleted or lost access
        console.warn(`Could not fetch page ${id}: ${(err as Error).message}`);
      }
    }
    return pages;
  }

  private async fetchPagesByDatabases(
    databaseIds: string[],
    lastSyncedAt: string | null
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];

    for (const dbId of databaseIds) {
      let cursor: string | undefined;
      do {
        const body: Record<string, unknown> = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        if (lastSyncedAt) {
          body.filter = {
            timestamp: "last_edited_time",
            last_edited_time: { after: lastSyncedAt },
          };
        }

        const response = await this.notionRequest<{
          results: NotionPage[];
          has_more: boolean;
          next_cursor: string | null;
        }>(`/databases/${this.normalizeId(dbId)}/query`, {
          method: "POST",
          body: JSON.stringify(body),
        });

        pages.push(...response.results);
        cursor = response.next_cursor ?? undefined;
      } while (cursor);
    }

    return pages;
  }

  private async fetchAllPages(
    lastSyncedAt: string | null
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;

      const response = await this.notionRequest<NotionSearchResponse>(
        "/search",
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );

      const filtered = lastSyncedAt
        ? response.results.filter(
            (p) => new Date(p.last_edited_time) > new Date(lastSyncedAt)
          )
        : response.results;

      pages.push(...filtered);
      cursor = response.next_cursor ?? undefined;

      // Early termination: if all results on this page are older than checkpoint
      // there is no point fetching more (Notion sorts by last_edited_time desc).
      if (
        lastSyncedAt &&
        filtered.length === 0 &&
        response.results.length > 0
      ) {
        break;
      }
    } while (cursor);

    return pages;
  }

  // ---------------------------------------------------------------------------
  // Document conversion
  // ---------------------------------------------------------------------------

  private async pageToDocument(page: NotionPage): Promise<SyncedDocument> {
    const title = this.extractTitle(page);
    const content = await this.fetchBlocksAsMarkdown(page.id, 0);

    return {
      id: page.id,
      title,
      content,
      url: page.url,
      sourceType: "notion",
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      metadata: {
        notionPageId: page.id,
        parentType: page.parent.type,
        parentId:
          page.parent.database_id ??
          page.parent.page_id ??
          page.parent.block_id ??
          null,
      },
    };
  }

  private extractTitle(page: NotionPage): string {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title" && prop.title && prop.title.length > 0) {
        return prop.title.map((t) => t.plain_text).join("");
      }
    }
    return "Untitled";
  }

  // ---------------------------------------------------------------------------
  // Block → Markdown
  // ---------------------------------------------------------------------------

  private async fetchBlocksAsMarkdown(
    blockId: string,
    depth: number
  ): Promise<string> {
    if (depth > MAX_BLOCK_DEPTH) return "";

    const blocks = await this.fetchAllBlocks(blockId);
    const lines: string[] = [];

    for (const block of blocks) {
      const line = await this.blockToMarkdown(block, depth);
      if (line) lines.push(line);
    }

    return lines.join("\n");
  }

  private async fetchAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);

      const response = await this.notionRequest<NotionBlocksResponse>(
        `/blocks/${blockId}/children?${params.toString()}`
      );

      blocks.push(...response.results);
      cursor = response.next_cursor ?? undefined;
    } while (cursor);

    return blocks;
  }

  private async blockToMarkdown(
    block: NotionBlock,
    depth: number
  ): Promise<string> {
    const indent = "  ".repeat(depth);
    const type = block.type as string;
    const data = (block as Record<string, unknown>)[type] as
      | Record<string, unknown>
      | undefined;

    if (!data) return "";

    const richText = (data.rich_text as Array<{ plain_text: string }>) ?? [];
    const text = richText.map((t) => t.plain_text).join("");

    let result = "";

    switch (type) {
      case "heading_1":
        result = `# ${text}`;
        break;
      case "heading_2":
        result = `## ${text}`;
        break;
      case "heading_3":
        result = `### ${text}`;
        break;
      case "paragraph":
        result = text;
        break;
      case "bulleted_list_item":
        result = `${indent}- ${text}`;
        break;
      case "numbered_list_item":
        result = `${indent}1. ${text}`;
        break;
      case "to_do": {
        const checked = (data.checked as boolean) ?? false;
        result = `${indent}- [${checked ? "x" : " "}] ${text}`;
        break;
      }
      case "toggle":
        result = `${indent}> ${text}`;
        break;
      case "quote":
        result = `> ${text}`;
        break;
      case "callout":
        result = `> ${text}`;
        break;
      case "code": {
        const lang = (data.language as string) ?? "";
        result = `\`\`\`${lang}\n${text}\n\`\`\``;
        break;
      }
      case "divider":
        result = "---";
        break;
      case "table_of_contents":
        result = "";
        break;
      case "image": {
        const imgData = data as Record<string, unknown>;
        const external = imgData.external as
          | Record<string, string>
          | undefined;
        const file = imgData.file as Record<string, string> | undefined;
        const url = external?.url ?? file?.url ?? "";
        const caption = (
          (imgData.caption as Array<{ plain_text: string }>) ?? []
        )
          .map((c) => c.plain_text)
          .join("");
        result = url ? `![${caption}](${url})` : "";
        break;
      }
      case "bookmark":
      case "link_preview": {
        const linkData = data as Record<string, unknown>;
        const url = (linkData.url as string) ?? "";
        result = url ? `[${url}](${url})` : "";
        break;
      }
      case "child_page": {
        const title = (data.title as string) ?? "Untitled";
        result = `**[${title}]**`;
        break;
      }
      case "child_database": {
        const title = (data.title as string) ?? "Untitled Database";
        result = `**[Database: ${title}]**`;
        break;
      }
      default:
        result = text;
    }

    // Recurse into children
    if (block.has_children && depth < MAX_BLOCK_DEPTH) {
      const childMarkdown = await this.fetchBlocksAsMarkdown(
        block.id,
        depth + 1
      );
      if (childMarkdown) {
        result = result
          ? `${result}\n${childMarkdown}`
          : childMarkdown;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Normalise UUIDs that may or may not have dashes */
  private normalizeId(id: string): string {
    const stripped = id.replace(/-/g, "");
    if (stripped.length === 32) {
      return [
        stripped.slice(0, 8),
        stripped.slice(8, 12),
        stripped.slice(12, 16),
        stripped.slice(16, 20),
        stripped.slice(20),
      ].join("-");
    }
    return id;
  }
}
