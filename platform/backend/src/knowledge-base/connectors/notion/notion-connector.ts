import type {
  KnowledgeConnector,
  KnowledgeDocument,
  SyncResult,
} from "../../../types/knowledge-connector";
import type { NotionConfig, NotionCheckpoint } from "../../../types/knowledge-connector";

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
}

interface NotionProperty {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
}

interface NotionParent {
  type: "database_id" | "page_id" | "workspace";
  database_id?: string;
  page_id?: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  paragraph?: { rich_text: NotionRichText[] };
  heading_1?: { rich_text: NotionRichText[] };
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
  quote?: { rich_text: NotionRichText[] };
  code?: { rich_text: NotionRichText[]; language: string };
  toggle?: { rich_text: NotionRichText[] };
  callout?: { rich_text: NotionRichText[]; icon?: { emoji?: string } };
  to_do?: { rich_text: NotionRichText[]; checked: boolean };
  divider?: Record<string, never>;
  child_page?: { title: string };
  child_database?: { title: string };
}

interface NotionRichText {
  plain_text: string;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
  };
}

interface NotionSearchResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

export class NotionConnector implements KnowledgeConnector<NotionConfig, NotionCheckpoint> {
  private readonly integrationToken: string;

  constructor(private readonly config: NotionConfig) {
    this.integrationToken = config.credentials.integrationToken;
  }

  async validateConfig(): Promise<void> {
    if (!this.integrationToken || !this.integrationToken.startsWith("secret_")) {
      throw new Error(
        "Invalid Notion integration token. It must start with 'secret_'."
      );
    }
  }

  async testConnection(): Promise<void> {
    await this.validateConfig();
    const response = await this.notionFetch("/users/me");
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        `Notion connection test failed (${response.status}): ${(body as { message?: string }).message ?? response.statusText}`
      );
    }
  }

  async sync(
    checkpoint: NotionCheckpoint | null,
    onDocument: (doc: KnowledgeDocument) => Promise<void>
  ): Promise<SyncResult<NotionCheckpoint>> {
    await this.validateConfig();

    const lastSyncedAt = checkpoint?.lastSyncedAt ?? null;
    const syncedAt = new Date().toISOString();
    let documentsProcessed = 0;
    let errors: string[] = [];

    const pageIds = this.config.pageIds ?? [];
    const databaseIds = this.config.databaseIds ?? [];

    if (pageIds.length > 0 || databaseIds.length > 0) {
      // Targeted / filtered sync
      for (const pageId of pageIds) {
        try {
          const page = await this.fetchPage(pageId);
          if (lastSyncedAt && page.last_edited_time <= lastSyncedAt) {
            continue;
          }
          const doc = await this.pageToDocument(page);
          await onDocument(doc);
          documentsProcessed++;
        } catch (err) {
          errors.push(`Failed to sync page ${pageId}: ${String(err)}`);
        }
      }

      for (const databaseId of databaseIds) {
        try {
          const pages = await this.queryDatabase(databaseId, lastSyncedAt);
          for (const page of pages) {
            try {
              const doc = await this.pageToDocument(page);
              await onDocument(doc);
              documentsProcessed++;
            } catch (err) {
              errors.push(`Failed to process page ${page.id}: ${String(err)}`);
            }
          }
        } catch (err) {
          errors.push(`Failed to query database ${databaseId}: ${String(err)}`);
        }
      }
    } else {
      // Full workspace sync via /search
      try {
        const pages = await this.searchAllPages(lastSyncedAt);
        for (const page of pages) {
          try {
            const doc = await this.pageToDocument(page);
            await onDocument(doc);
            documentsProcessed++;
          } catch (err) {
            errors.push(`Failed to process page ${page.id}: ${String(err)}`);
          }
        }
      } catch (err) {
        errors.push(`Failed to search workspace: ${String(err)}`);
      }
    }

    return {
      checkpoint: { lastSyncedAt: syncedAt },
      documentsProcessed,
      errors,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private notionFetch(path: string, options?: RequestInit): Promise<Response> {
    return fetch(`${NOTION_API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.integrationToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
    });
  }

  private async fetchPage(pageId: string): Promise<NotionPage> {
    const response = await this.notionFetch(`/pages/${pageId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch page ${pageId}: ${response.statusText}`);
    }
    return response.json() as Promise<NotionPage>;
  }

  private async queryDatabase(
    databaseId: string,
    lastSyncedAt: string | null
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;

    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      if (lastSyncedAt) {
        body.filter = {
          timestamp: "last_edited_time",
          last_edited_time: { after: lastSyncedAt },
        };
      }

      const response = await this.notionFetch(`/databases/${databaseId}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to query database ${databaseId}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as NotionSearchResponse;
      pages.push(...data.results);
      cursor = data.next_cursor;
    } while (cursor);

    return pages;
  }

  private async searchAllPages(lastSyncedAt: string | null): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;

    do {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        page_size: 100,
        sort: { direction: "descending", timestamp: "last_edited_time" },
      };
      if (cursor) body.start_cursor = cursor;

      const response = await this.notionFetch("/search", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to search Notion: ${response.statusText}`);
      }

      const data = (await response.json()) as NotionSearchResponse;

      for (const page of data.results) {
        if (lastSyncedAt && page.last_edited_time <= lastSyncedAt) {
          // Since results are sorted by last_edited_time desc, we can stop early
          cursor = null;
          break;
        }
        pages.push(page);
      }

      if (cursor !== null) cursor = data.next_cursor;
    } while (cursor);

    return pages;
  }

  private async pageToDocument(page: NotionPage): Promise<KnowledgeDocument> {
    const title = this.extractTitle(page);
    const content = await this.fetchBlocksAsMarkdown(page.id, 0);

    return {
      id: page.id,
      title,
      content,
      url: page.url,
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      metadata: {
        source: "notion",
        pageId: page.id,
        parentType: page.parent.type,
        parentId:
          page.parent.database_id ??
          page.parent.page_id ??
          "workspace",
      },
    };
  }

  private extractTitle(page: NotionPage): string {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title" && prop.title && prop.title.length > 0) {
        return prop.title.map((t) => t.plain_text).join("");
      }
    }
    return page.id;
  }

  private async fetchBlocksAsMarkdown(
    blockId: string,
    depth: number
  ): Promise<string> {
    if (depth > MAX_BLOCK_DEPTH) return "";

    const blocks = await this.fetchAllBlocks(blockId);
    const lines: string[] = [];

    for (const block of blocks) {
      const line = this.blockToMarkdown(block);
      if (line !== null) lines.push(line);

      if (block.has_children && depth < MAX_BLOCK_DEPTH) {
        const childContent = await this.fetchBlocksAsMarkdown(block.id, depth + 1);
        if (childContent) {
          const indented = childContent
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n");
          lines.push(indented);
        }
      }
    }

    return lines.join("\n");
  }

  private async fetchAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;

    do {
      const path = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
      const response = await this.notionFetch(path);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch blocks for ${blockId}: ${response.statusText}`
        );
      }
      const data = (await response.json()) as NotionBlocksResponse;
      blocks.push(...data.results);
      cursor = data.next_cursor;
    } while (cursor);

    return blocks;
  }

  private blockToMarkdown(block: NotionBlock): string | null {
    switch (block.type) {
      case "heading_1":
        return `# ${this.richTextToString(block.heading_1!.rich_text)}`;
      case "heading_2":
        return `## ${this.richTextToString(block.heading_2!.rich_text)}`;
      case "heading_3":
        return `### ${this.richTextToString(block.heading_3!.rich_text)}`;
      case "paragraph":
        return this.richTextToString(block.paragraph!.rich_text);
      case "bulleted_list_item":
        return `- ${this.richTextToString(block.bulleted_list_item!.rich_text)}`;
      case "numbered_list_item":
        return `1. ${this.richTextToString(block.numbered_list_item!.rich_text)}`;
      case "quote":
        return `> ${this.richTextToString(block.quote!.rich_text)}`;
      case "code": {
        const lang = block.code!.language ?? "";
        const code = this.richTextToString(block.code!.rich_text);
        return `\`\`\`${lang}\n${code}\n\`\`\``;
      }
      case "toggle":
        return this.richTextToString(block.toggle!.rich_text);
      case "callout": {
        const emoji = block.callout!.icon?.emoji ?? "💡";
        return `> ${emoji} ${this.richTextToString(block.callout!.rich_text)}`;
      }
      case "to_do": {
        const checked = block.to_do!.checked ? "[x]" : "[ ]";
        return `- ${checked} ${this.richTextToString(block.to_do!.rich_text)}`;
      }
      case "divider":
        return "---";
      case "child_page":
        return `📄 ${block.child_page!.title}`;
      case "child_database":
        return `🗄️ ${block.child_database!.title}`;
      default:
        return null;
    }
  }

  private richTextToString(richTexts: NotionRichText[]): string {
    if (!richTexts || richTexts.length === 0) return "";
    return richTexts.map((rt) => rt.plain_text).join("");
  }
}
