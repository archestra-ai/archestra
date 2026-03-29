import type {
  KnowledgeConnectorSyncResult,
  KnowledgeDocument,
} from "../../../types/knowledge-connector";
import type { NotionConfig, NotionCheckpoint } from "../../../types/knowledge-connector";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_BLOCK_DEPTH = 3;

interface NotionPage {
  id: string;
  object: "page" | "database";
  url: string;
  last_edited_time: string;
  created_time: string;
  properties: Record<string, NotionProperty>;
  parent: NotionParent;
}

interface NotionParent {
  type: "database_id" | "page_id" | "workspace" | "block_id";
  database_id?: string;
  page_id?: string;
}

interface NotionProperty {
  id: string;
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  number?: number | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start: string; end: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  formula?: { string?: string; number?: number; boolean?: boolean };
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
  to_do?: { rich_text: NotionRichText[]; checked: boolean };
  toggle?: { rich_text: NotionRichText[] };
  quote?: { rich_text: NotionRichText[] };
  callout?: { rich_text: NotionRichText[]; icon?: { emoji?: string } };
  code?: { rich_text: NotionRichText[]; language: string };
  divider?: Record<string, never>;
  table_of_contents?: Record<string, never>;
  child_page?: { title: string };
  child_database?: { title: string };
  image?: { type: "external" | "file"; external?: { url: string }; file?: { url: string } };
  bookmark?: { url: string; caption: NotionRichText[] };
  [key: string]: unknown;
}

interface NotionRichText {
  plain_text: string;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
  href?: string | null;
}

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlockChildrenResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

function richTextToMarkdown(richTexts: NotionRichText[]): string {
  return richTexts
    .map((rt) => {
      let text = rt.plain_text;
      if (!text) return "";
      const ann = rt.annotations ?? {};
      if (ann.code) text = `\`${text}\``;
      if (ann.bold) text = `**${text}**`;
      if (ann.italic) text = `_${text}_`;
      if (ann.strikethrough) text = `~~${text}~~`;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    })
    .join("");
}

function blockToMarkdown(block: NotionBlock, depth: number): string {
  const indent = "  ".repeat(Math.max(0, depth - 1));
  switch (block.type) {
    case "paragraph":
      return block.paragraph ? richTextToMarkdown(block.paragraph.rich_text) + "\n" : "";
    case "heading_1":
      return block.heading_1 ? `# ${richTextToMarkdown(block.heading_1.rich_text)}\n` : "";
    case "heading_2":
      return block.heading_2 ? `## ${richTextToMarkdown(block.heading_2.rich_text)}\n` : "";
    case "heading_3":
      return block.heading_3 ? `### ${richTextToMarkdown(block.heading_3.rich_text)}\n` : "";
    case "bulleted_list_item":
      return block.bulleted_list_item
        ? `${indent}- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}\n`
        : "";
    case "numbered_list_item":
      return block.numbered_list_item
        ? `${indent}1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}\n`
        : "";
    case "to_do":
      if (!block.to_do) return "";
      return `${indent}- [${block.to_do.checked ? "x" : " "}] ${richTextToMarkdown(block.to_do.rich_text)}\n`;
    case "toggle":
      return block.toggle ? richTextToMarkdown(block.toggle.rich_text) + "\n" : "";
    case "quote":
      return block.quote
        ? `> ${richTextToMarkdown(block.quote.rich_text)}\n`
        : "";
    case "callout": {
      if (!block.callout) return "";
      const emoji = block.callout.icon?.emoji ?? "💡";
      return `> ${emoji} ${richTextToMarkdown(block.callout.rich_text)}\n`;
    }
    case "code": {
      if (!block.code) return "";
      const lang = block.code.language ?? "";
      const codeText = block.code.rich_text.map((rt) => rt.plain_text).join("");
      return `\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
    }
    case "divider":
      return "---\n";
    case "child_page":
      return block.child_page ? `📄 **${block.child_page.title}**\n` : "";
    case "child_database":
      return block.child_database ? `🗄️ **${block.child_database.title}**\n` : "";
    case "image": {
      if (!block.image) return "";
      const url =
        block.image.type === "external"
          ? block.image.external?.url
          : block.image.file?.url;
      return url ? `![image](${url})\n` : "";
    }
    case "bookmark":
      return block.bookmark ? `[${block.bookmark.url}](${block.bookmark.url})\n` : "";
    default:
      return "";
  }
}

function extractPageTitle(page: NotionPage): string {
  // Try to find a title property
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title && prop.title.length > 0) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return page.id;
}

export class NotionConnector {
  private readonly config: NotionConfig;
  private readonly integrationToken: string;

  constructor(config: NotionConfig, integrationToken: string) {
    this.config = config;
    this.integrationToken = integrationToken;
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${NOTION_API_BASE}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.integrationToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Notion API error ${response.status} ${response.statusText}: ${body}`
      );
    }

    return response.json() as Promise<T>;
  }

  async validateConfig(): Promise<void> {
    if (!this.integrationToken || !this.integrationToken.startsWith("secret_")) {
      throw new Error(
        "Invalid Notion Integration Token. It must start with 'secret_'."
      );
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.validateConfig();
      // Test by hitting /users/me
      await this.fetch("/users/me");
      return { success: true, message: "Successfully connected to Notion." };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: msg };
    }
  }

  private async fetchAllPages(lastSyncedAt?: string): Promise<NotionPage[]> {
    const { pageIds, databaseIds } = this.config;

    // If specific pageIds are provided, fetch those directly
    if (pageIds && pageIds.length > 0) {
      const pages: NotionPage[] = [];
      for (const pageId of pageIds) {
        try {
          const page = await this.fetch<NotionPage>(`/pages/${pageId}`);
          pages.push(page);
        } catch {
          // Skip pages we can't access
        }
      }
      return pages;
    }

    // If specific databaseIds are provided, query those databases
    if (databaseIds && databaseIds.length > 0) {
      const pages: NotionPage[] = [];
      for (const dbId of databaseIds) {
        let cursor: string | null = null;
        do {
          const body: Record<string, unknown> = {
            page_size: 100,
          };
          if (cursor) body.start_cursor = cursor;
          if (lastSyncedAt) {
            body.filter = {
              timestamp: "last_edited_time",
              last_edited_time: { on_or_after: lastSyncedAt },
            };
          }
          const resp = await this.fetch<NotionSearchResponse>(
            `/databases/${dbId}/query`,
            {
              method: "POST",
              body: JSON.stringify(body),
            }
          );
          pages.push(...resp.results);
          cursor = resp.has_more ? resp.next_cursor : null;
        } while (cursor);
      }
      return pages;
    }

    // Full workspace sync via /search
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: { value: "page", property: "object" },
      };
      if (cursor) body.start_cursor = cursor;
      if (lastSyncedAt) {
        // Notion /search doesn't support date filters directly; we'll filter client-side
      }
      const resp = await this.fetch<NotionSearchResponse>("/search", {
        method: "POST",
        body: JSON.stringify(body),
      });

      for (const page of resp.results) {
        if (
          lastSyncedAt &&
          new Date(page.last_edited_time) <= new Date(lastSyncedAt)
        ) {
          continue;
        }
        pages.push(page);
      }

      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);

    return pages;
  }

  private async fetchBlocksAsMarkdown(
    blockId: string,
    depth: number
  ): Promise<string> {
    if (depth > MAX_BLOCK_DEPTH) return "";

    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const path =
        `/blocks/${blockId}/children?page_size=100` +
        (cursor ? `&start_cursor=${cursor}` : "");
      const resp = await this.fetch<NotionBlockChildrenResponse>(path);
      blocks.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);

    const parts: string[] = [];
    for (const block of blocks) {
      const line = blockToMarkdown(block, depth);
      parts.push(line);
      if (block.has_children && depth < MAX_BLOCK_DEPTH) {
        const childContent = await this.fetchBlocksAsMarkdown(block.id, depth + 1);
        if (childContent) parts.push(childContent);
      }
    }

    return parts.join("");
  }

  async sync(checkpoint?: NotionCheckpoint): Promise<KnowledgeConnectorSyncResult> {
    const lastSyncedAt = checkpoint?.lastSyncedAt;
    const documents: KnowledgeDocument[] = [];
    const errors: string[] = [];
    const syncedAt = new Date().toISOString();

    let pages: NotionPage[];
    try {
      pages = await this.fetchAllPages(lastSyncedAt);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        documents: [],
        errors: [`Failed to list pages: ${msg}`],
        checkpoint: checkpoint ?? { lastSyncedAt: syncedAt },
      };
    }

    for (const page of pages) {
      try {
        const title = extractPageTitle(page);
        const content = await this.fetchBlocksAsMarkdown(page.id, 1);

        documents.push({
          id: page.id,
          title,
          content: content.trim(),
          url: page.url,
          sourceType: "notion",
          createdAt: page.created_time,
          updatedAt: page.last_edited_time,
          metadata: {
            pageId: page.id,
            parentType: page.parent.type,
            ...(page.parent.database_id
              ? { databaseId: page.parent.database_id }
              : {}),
            ...(page.parent.page_id ? { parentPageId: page.parent.page_id } : {}),
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to sync page ${page.id}: ${msg}`);
      }
    }

    return {
      documents,
      errors,
      checkpoint: { lastSyncedAt: syncedAt },
    };
  }
}
