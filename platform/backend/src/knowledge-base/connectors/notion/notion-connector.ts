import type {
  KnowledgeConnectorBase,
  SyncResult,
  SyncedDocument,
} from "../../../types/knowledge-connector.js";
import type { NotionConfig, NotionCheckpoint } from "../../../types/knowledge-connector.js";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function notionFetch(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${NOTION_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Notion API error ${res.status} for ${path}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Notion response types (minimal)
// ---------------------------------------------------------------------------

interface NotionPage {
  id: string;
  object: "page" | "database";
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
  parent: NotionParent;
}

interface NotionDatabase {
  id: string;
  object: "database";
  url: string;
  last_edited_time: string;
  title: NotionRichText[];
}

interface NotionParent {
  type: string;
  database_id?: string;
  page_id?: string;
  workspace?: boolean;
}

interface NotionRichText {
  type: "text" | "mention" | "equation";
  plain_text: string;
}

type NotionProperty =
  | { type: "title"; title: NotionRichText[] }
  | { type: "rich_text"; rich_text: NotionRichText[] }
  | { type: string; [key: string]: unknown };

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

interface NotionPaginatedResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Search / list helpers
// ---------------------------------------------------------------------------

async function searchAllPages(
  token: string,
  filterType?: "page" | "database",
  startCursor?: string
): Promise<NotionPaginatedResponse<NotionPage>> {
  const body: Record<string, unknown> = {
    page_size: 100,
    sort: { direction: "descending", timestamp: "last_edited_time" },
  };
  if (filterType) {
    body.filter = { property: "object", value: filterType };
  }
  if (startCursor) {
    body.start_cursor = startCursor;
  }

  return notionFetch("/search", token, {
    method: "POST",
    body: JSON.stringify(body),
  }) as Promise<NotionPaginatedResponse<NotionPage>>;
}

async function queryDatabase(
  token: string,
  databaseId: string,
  startCursor?: string
): Promise<NotionPaginatedResponse<NotionPage>> {
  const body: Record<string, unknown> = { page_size: 100 };
  if (startCursor) {
    body.start_cursor = startCursor;
  }

  return notionFetch(`/databases/${databaseId}/query`, token, {
    method: "POST",
    body: JSON.stringify(body),
  }) as Promise<NotionPaginatedResponse<NotionPage>>;
}

async function getPage(token: string, pageId: string): Promise<NotionPage> {
  return notionFetch(`/pages/${pageId}`, token) as Promise<NotionPage>;
}

async function getBlocks(
  token: string,
  blockId: string,
  startCursor?: string
): Promise<NotionPaginatedResponse<NotionBlock>> {
  const params = new URLSearchParams({ page_size: "100" });
  if (startCursor) params.set("start_cursor", startCursor);

  return notionFetch(`/blocks/${blockId}/children?${params.toString()}`, token) as Promise<
    NotionPaginatedResponse<NotionBlock>
  >;
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

async function* paginateSearch(
  token: string,
  filterType?: "page" | "database"
): AsyncGenerator<NotionPage> {
  let cursor: string | undefined;
  do {
    const response = await searchAllPages(token, filterType, cursor);
    for (const item of response.results) {
      yield item;
    }
    cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
  } while (cursor);
}

async function* paginateDatabase(
  token: string,
  databaseId: string
): AsyncGenerator<NotionPage> {
  let cursor: string | undefined;
  do {
    const response = await queryDatabase(token, databaseId, cursor);
    for (const item of response.results) {
      yield item;
    }
    cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
  } while (cursor);
}

async function getAllBlocks(
  token: string,
  blockId: string
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const response = await getBlocks(token, blockId, cursor);
    blocks.push(...response.results);
    cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

function extractTitle(page: NotionPage): string {
  // Pages have a title property; databases have a title array at top level
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title") {
      const titleProp = prop as { type: "title"; title: NotionRichText[] };
      return titleProp.title.map((t) => t.plain_text).join("").trim() || "Untitled";
    }
  }
  return "Untitled";
}

function richTextToMarkdown(richTexts: NotionRichText[]): string {
  return richTexts.map((rt) => rt.plain_text).join("");
}

// ---------------------------------------------------------------------------
// Block → Markdown converter (up to 3 levels deep)
// ---------------------------------------------------------------------------

async function blocksToMarkdown(
  token: string,
  blocks: NotionBlock[],
  depth: number = 0
): Promise<string> {
  if (depth > 2) return ""; // max 3 levels (0, 1, 2)

  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  for (const block of blocks) {
    const type = block.type as string;
    const data = block[type] as Record<string, unknown> | undefined;

    if (!data) {
      lines.push("");
      continue;
    }

    const richText = (data.rich_text as NotionRichText[] | undefined) ?? [];
    const text = richTextToMarkdown(richText);

    switch (type) {
      case "paragraph":
        lines.push(`${indent}${text}`);
        break;
      case "heading_1":
        lines.push(`${indent}# ${text}`);
        break;
      case "heading_2":
        lines.push(`${indent}## ${text}`);
        break;
      case "heading_3":
        lines.push(`${indent}### ${text}`);
        break;
      case "bulleted_list_item":
        lines.push(`${indent}- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${text}`);
        break;
      case "to_do": {
        const checked = (data.checked as boolean | undefined) ?? false;
        lines.push(`${indent}- [${checked ? "x" : " "}] ${text}`);
        break;
      }
      case "toggle":
        lines.push(`${indent}> **${text}**`);
        break;
      case "quote":
        lines.push(`${indent}> ${text}`);
        break;
      case "callout":
        lines.push(`${indent}> ${text}`);
        break;
      case "code": {
        const language = (data.language as string | undefined) ?? "";
        lines.push(`${indent}\`\`\`${language}`);
        lines.push(`${indent}${text}`);
        lines.push(`${indent}\`\`\``);
        break;
      }
      case "divider":
        lines.push(`${indent}---`);
        break;
      case "image": {
        const imgData = data as {
          type?: string;
          external?: { url: string };
          file?: { url: string };
          caption?: NotionRichText[];
        };
        const url =
          imgData.type === "external"
            ? imgData.external?.url
            : imgData.file?.url;
        const caption = richTextToMarkdown(imgData.caption ?? []);
        if (url) {
          lines.push(`${indent}![${caption}](${url})`);
        }
        break;
      }
      case "bookmark":
      case "link_preview": {
        const url = (data.url as string | undefined) ?? "";
        lines.push(`${indent}[${url}](${url})`);
        break;
      }
      case "child_page":
        lines.push(`${indent}*[Child page: ${(data.title as string | undefined) ?? ""}]*`);
        break;
      case "child_database":
        lines.push(
          `${indent}*[Child database: ${(data.title as string | undefined) ?? ""}]*`
        );
        break;
      case "table_of_contents":
        // skip — auto-generated
        break;
      default:
        if (text) {
          lines.push(`${indent}${text}`);
        }
    }

    // Recursively fetch and convert children
    if (block.has_children && depth < 2) {
      try {
        const childBlocks = await getAllBlocks(token, block.id);
        const childMarkdown = await blocksToMarkdown(token, childBlocks, depth + 1);
        if (childMarkdown) {
          lines.push(childMarkdown);
        }
      } catch {
        // ignore child fetch errors
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Page content fetcher
// ---------------------------------------------------------------------------

async function fetchPageContent(token: string, page: NotionPage): Promise<string> {
  try {
    const blocks = await getAllBlocks(token, page.id);
    const markdown = await blocksToMarkdown(token, blocks);
    return markdown.trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// NotionConnector
// ---------------------------------------------------------------------------

export class NotionConnector implements KnowledgeConnectorBase<NotionConfig, NotionCheckpoint> {
  readonly type = "notion" as const;

  async validateConfig(config: NotionConfig): Promise<void> {
    if (!config.integrationToken || !config.integrationToken.startsWith("secret_")) {
      throw new Error(
        'Invalid Notion Integration Token. It must start with "secret_".'
      );
    }
  }

  async testConnection(config: NotionConfig): Promise<void> {
    await this.validateConfig(config);
    // A lightweight call: retrieve the bot user
    await notionFetch("/users/me", config.integrationToken);
  }

  async sync(
    config: NotionConfig,
    checkpoint: NotionCheckpoint | null,
    onDocument: (doc: SyncedDocument) => Promise<void>
  ): Promise<SyncResult<NotionCheckpoint>> {
    const token = config.integrationToken;
    const lastSyncedAt = checkpoint?.lastSyncedAt ?? null;
    const newCheckpoint: NotionCheckpoint = { lastSyncedAt: new Date().toISOString() };

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    const processPage = async (page: NotionPage): Promise<void> => {
      try {
        // Incremental sync: skip if not modified since last sync
        if (lastSyncedAt && page.last_edited_time <= lastSyncedAt) {
          skipped++;
          return;
        }

        const title = extractTitle(page);
        const content = await fetchPageContent(token, page);

        if (!content && !title) {
          skipped++;
          return;
        }

        await onDocument({
          id: page.id,
          title,
          content,
          url: page.url,
          updatedAt: page.last_edited_time,
          metadata: {
            source: "notion",
            pageId: page.id,
            parentType: page.parent?.type ?? "unknown",
          },
        });

        synced++;
      } catch (err) {
        errors++;
        console.error(
          `[NotionConnector] Failed to sync page ${page.id}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    };

    // Strategy 1: explicit pageIds
    if (config.pageIds && config.pageIds.length > 0) {
      for (const pageId of config.pageIds) {
        try {
          const page = await getPage(token, pageId);
          await processPage(page);
        } catch (err) {
          errors++;
          console.error(
            `[NotionConnector] Failed to fetch page ${pageId}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
      return { checkpoint: newCheckpoint, synced, skipped, errors };
    }

    // Strategy 2: specific databases
    if (config.databaseIds && config.databaseIds.length > 0) {
      for (const dbId of config.databaseIds) {
        for await (const page of paginateDatabase(token, dbId)) {
          await processPage(page);
        }
      }
      return { checkpoint: newCheckpoint, synced, skipped, errors };
    }

    // Strategy 3: full workspace search
    for await (const page of paginateSearch(token, "page")) {
      await processPage(page);
    }

    return { checkpoint: newCheckpoint, synced, skipped, errors };
  }
}
