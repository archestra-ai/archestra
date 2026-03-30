import type {
  KnowledgeConnectorConfig,
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
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, NotionProperty>;
  parent: NotionParent;
}

interface NotionParent {
  type: "database_id" | "page_id" | "workspace" | "block_id";
  database_id?: string;
  page_id?: string;
}

interface NotionProperty {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  [key: string]: unknown;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface NotionSearchResult {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionBlockChildrenResult {
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function fetchAllPages(
  token: string,
  filter?: { property: "object"; value: "page" | "database" }
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      page_size: 100,
    };
    if (filter) {
      body.filter = filter;
    }
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const response = await fetch(`${NOTION_API_BASE}/search`, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as NotionSearchResult;
    pages.push(...data.results);
    startCursor = data.next_cursor ?? undefined;
  } while (startCursor);

  return pages;
}

async function fetchPage(token: string, pageId: string): Promise<NotionPage> {
  const response = await fetch(`${NOTION_API_BASE}/pages/${pageId}`, {
    method: "GET",
    headers: notionHeaders(token),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Notion API error fetching page ${pageId} (${response.status}): ${errorText}`);
  }

  return (await response.json()) as NotionPage;
}

async function fetchBlockChildren(
  token: string,
  blockId: string
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let startCursor: string | undefined;

  do {
    const url = new URL(`${NOTION_API_BASE}/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (startCursor) {
      url.searchParams.set("start_cursor", startCursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: notionHeaders(token),
    });

    if (!response.ok) {
      // Block may not have children — return what we have
      break;
    }

    const data = (await response.json()) as NotionBlockChildrenResult;
    blocks.push(...data.results);
    startCursor = data.next_cursor ?? undefined;
  } while (startCursor);

  return blocks;
}

function getRichText(richTextArr: Array<{ plain_text: string }> | undefined): string {
  if (!richTextArr || richTextArr.length === 0) return "";
  return richTextArr.map((t) => t.plain_text).join("");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blockToMarkdown(block: NotionBlock, depth: number): string {
  const indent = "  ".repeat(Math.max(0, depth - 1));
  const type = block.type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (block as any)[type] as Record<string, unknown> | undefined;

  if (!data) return "";

  const richTextArr = data.rich_text as Array<{ plain_text: string }> | undefined;
  const text = getRichText(richTextArr);

  switch (type) {
    case "paragraph":
      return `${text}\n\n`;
    case "heading_1":
      return `# ${text}\n\n`;
    case "heading_2":
      return `## ${text}\n\n`;
    case "heading_3":
      return `### ${text}\n\n`;
    case "bulleted_list_item":
      return `${indent}- ${text}\n`;
    case "numbered_list_item":
      return `${indent}1. ${text}\n`;
    case "to_do": {
      const checked = data.checked as boolean | undefined;
      return `${indent}- [${checked ? "x" : " "}] ${text}\n`;
    }
    case "toggle":
      return `${indent}> ${text}\n`;
    case "quote":
      return `> ${text}\n\n`;
    case "callout": {
      const icon = data.icon as { type: string; emoji?: string } | undefined;
      const emoji = icon?.emoji ?? "💡";
      return `> ${emoji} ${text}\n\n`;
    }
    case "code": {
      const language = (data.language as string | undefined) ?? "";
      return `\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
    case "divider":
      return `---\n\n`;
    case "image": {
      const imageData = data as Record<string, unknown>;
      const external = imageData.external as { url: string } | undefined;
      const file = imageData.file as { url: string } | undefined;
      const url = external?.url ?? file?.url ?? "";
      const caption = getRichText(
        (imageData.caption as Array<{ plain_text: string }> | undefined)
      );
      return `![${caption}](${url})\n\n`;
    }
    case "video":
    case "file":
    case "pdf": {
      const mediaData = data as Record<string, unknown>;
      const external = mediaData.external as { url: string } | undefined;
      const file = mediaData.file as { url: string } | undefined;
      const url = external?.url ?? file?.url ?? "";
      return url ? `[${type}](${url})\n\n` : "";
    }
    case "bookmark": {
      const url = (data.url as string | undefined) ?? "";
      const caption = getRichText(
        (data.caption as Array<{ plain_text: string }> | undefined)
      );
      return `[${caption || url}](${url})\n\n`;
    }
    case "equation": {
      const expression = (data.expression as string | undefined) ?? "";
      return `$$${expression}$$\n\n`;
    }
    case "table_of_contents":
      return "";
    case "breadcrumb":
      return "";
    case "column_list":
    case "column":
      // Children will be rendered recursively
      return "";
    default:
      return text ? `${text}\n\n` : "";
  }
}

async function fetchBlocksRecursive(
  token: string,
  blockId: string,
  depth: number
): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) return "";

  const blocks = await fetchBlockChildren(token, blockId);
  let markdown = "";

  for (const block of blocks) {
    markdown += blockToMarkdown(block, depth);

    if (block.has_children && depth < MAX_BLOCK_DEPTH) {
      const childMarkdown = await fetchBlocksRecursive(token, block.id, depth + 1);
      markdown += childMarkdown;
    }
  }

  return markdown;
}

function extractPageTitle(page: NotionPage): string {
  // Pages store title in a "title" property; databases may differ
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === "title" && prop.title && prop.title.length > 0) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

async function syncPage(
  token: string,
  page: NotionPage
): Promise<KnowledgeDocument> {
  const title = extractPageTitle(page);
  const content = await fetchBlocksRecursive(token, page.id, 1);

  return {
    id: page.id,
    title,
    content: content.trim(),
    url: page.url,
    metadata: {
      source: "notion",
      pageId: page.id,
      createdTime: page.created_time,
      lastEditedTime: page.last_edited_time,
      parentType: page.parent.type,
      parentId:
        page.parent.database_id ??
        page.parent.page_id ??
        undefined,
    },
    updatedAt: new Date(page.last_edited_time),
  };
}

export class NotionConnector {
  private readonly token: string;
  private readonly config: NotionConfig;

  constructor(config: KnowledgeConnectorConfig & { connectorType: "notion" }) {
    this.token = config.credentials.integrationToken;
    this.config = config as NotionConfig;
  }

  async validateConfig(): Promise<void> {
    if (!this.token || !this.token.startsWith("secret_")) {
      throw new Error(
        "Invalid Notion Integration Token. It must start with 'secret_'."
      );
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`${NOTION_API_BASE}/users/me`, {
        method: "GET",
        headers: notionHeaders(this.token),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          message: `Connection failed (${response.status}): ${errorText}`,
        };
      }

      const user = (await response.json()) as { name?: string; type?: string };
      const name = user.name ?? "Notion Integration";
      return {
        success: true,
        message: `Connected successfully as "${name}"`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async sync(checkpoint?: NotionCheckpoint): Promise<KnowledgeConnectorSyncResult> {
    const documents: KnowledgeDocument[] = [];
    const errors: string[] = [];

    const lastSyncedAt = checkpoint?.lastSyncedAt
      ? new Date(checkpoint.lastSyncedAt)
      : undefined;

    try {
      let pagesToSync: NotionPage[] = [];

      const { pageIds, databaseIds } = this.config;

      if (pageIds && pageIds.length > 0) {
        // Targeted sync: fetch only specified pages
        for (const pageId of pageIds) {
          try {
            const page = await fetchPage(this.token, pageId);
            pagesToSync.push(page);
          } catch (err) {
            errors.push(
              `Failed to fetch page ${pageId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      } else if (databaseIds && databaseIds.length > 0) {
        // Filtered sync: only pages belonging to specific databases
        const allPages = await fetchAllPages(this.token, {
          property: "object",
          value: "page",
        });
        pagesToSync = allPages.filter(
          (page) =>
            page.parent.type === "database_id" &&
            page.parent.database_id &&
            databaseIds.includes(page.parent.database_id)
        );
      } else {
        // Full workspace sync
        pagesToSync = await fetchAllPages(this.token, {
          property: "object",
          value: "page",
        });
      }

      // Apply incremental checkpoint
      if (lastSyncedAt) {
        pagesToSync = pagesToSync.filter(
          (page) => new Date(page.last_edited_time) > lastSyncedAt
        );
      }

      // Sync each page
      for (const page of pagesToSync) {
        try {
          const doc = await syncPage(this.token, page);
          documents.push(doc);
        } catch (err) {
          errors.push(
            `Failed to sync page ${page.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } catch (error) {
      errors.push(
        `Sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const newCheckpoint: NotionCheckpoint = {
      lastSyncedAt: new Date().toISOString(),
    };

    return {
      documents,
      checkpoint: newCheckpoint,
      errors,
    };
  }
}
