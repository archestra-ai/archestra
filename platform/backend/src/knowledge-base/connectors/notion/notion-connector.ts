import type {
  KnowledgeConnectorConfig,
  KnowledgeConnectorResult,
  NotionCheckpoint,
  NotionConfig,
} from "../../../types/knowledge-connector";

// ---------------------------------------------------------------------------
// Notion REST API types (minimal surface needed for the connector)
// ---------------------------------------------------------------------------

interface NotionSearchResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionPage {
  id: string;
  object: "page" | "database";
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  id: string;
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";
const MAX_BLOCK_DEPTH = 3;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Helper — plain HTTP fetch wrapper (no SDK dependency)
// ---------------------------------------------------------------------------

async function notionFetch<T>(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${NOTION_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Notion API error ${res.status} for ${path}: ${body}`
    );
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Block → Markdown conversion
// ---------------------------------------------------------------------------

function richTextToString(
  richTexts: Array<{ plain_text: string }> | undefined
): string {
  return (richTexts ?? []).map((t) => t.plain_text).join("");
}

function blockToMarkdown(block: NotionBlock, depth: number): string {
  const indent = "  ".repeat(Math.max(0, depth - 1));
  const type = block.type as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (block as any)[type] as Record<string, unknown> | undefined;

  if (!data) return "";

  const text = richTextToString(
    data.rich_text as Array<{ plain_text: string }> | undefined
  );

  switch (type) {
    case "paragraph":
      return text ? `${text}\n` : "";
    case "heading_1":
      return `# ${text}\n`;
    case "heading_2":
      return `## ${text}\n`;
    case "heading_3":
      return `### ${text}\n`;
    case "bulleted_list_item":
      return `${indent}- ${text}\n`;
    case "numbered_list_item":
      return `${indent}1. ${text}\n`;
    case "to_do": {
      const checked = (data.checked as boolean) ? "x" : " ";
      return `${indent}- [${checked}] ${text}\n`;
    }
    case "toggle":
      return `${indent}> ${text}\n`;
    case "quote":
      return `> ${text}\n`;
    case "callout":
      return `> ${text}\n`;
    case "code": {
      const lang = (data.language as string) ?? "";
      const codeText = richTextToString(
        data.rich_text as Array<{ plain_text: string }> | undefined
      );
      return `\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
    }
    case "divider":
      return "---\n";
    case "image": {
      const imgData = data as Record<string, unknown>;
      const urlField =
        (imgData.external as { url: string } | undefined)?.url ??
        (imgData.file as { url: string } | undefined)?.url ??
        "";
      const caption = richTextToString(
        imgData.caption as Array<{ plain_text: string }> | undefined
      );
      return `![${caption}](${urlField})\n`;
    }
    case "bookmark": {
      const url = (data.url as string) ?? "";
      const caption = richTextToString(
        data.caption as Array<{ plain_text: string }> | undefined
      );
      return `[${caption || url}](${url})\n`;
    }
    default:
      return text ? `${text}\n` : "";
  }
}

// ---------------------------------------------------------------------------
// Fetch and render blocks recursively up to MAX_BLOCK_DEPTH levels
// ---------------------------------------------------------------------------

async function fetchBlocksAsMarkdown(
  blockId: string,
  token: string,
  depth: number
): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) return "";

  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      page_size: String(PAGE_SIZE),
    });
    if (cursor) params.set("start_cursor", cursor);

    const data = await notionFetch<NotionBlocksResponse>(
      `/blocks/${blockId}/children?${params.toString()}`,
      token
    );

    for (const block of data.results) {
      lines.push(blockToMarkdown(block, depth));

      if (block.has_children && depth < MAX_BLOCK_DEPTH) {
        const childMd = await fetchBlocksAsMarkdown(block.id, token, depth + 1);
        if (childMd) lines.push(childMd);
      }
    }

    cursor = data.next_cursor ?? undefined;
  } while (cursor);

  return lines.join("");
}

// ---------------------------------------------------------------------------
// Extract page title from Notion page properties
// ---------------------------------------------------------------------------

function extractPageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text).join("").trim();
    }
  }
  return page.id;
}

// ---------------------------------------------------------------------------
// Collect all pages accessible to the token via /search
// ---------------------------------------------------------------------------

async function searchAllPages(
  token: string,
  lastSyncedAt?: string
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filter: { value: "page", property: "object" },
      page_size: PAGE_SIZE,
    };
    if (cursor) body.start_cursor = cursor;

    const data = await notionFetch<NotionSearchResponse>(
      "/search",
      token,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    for (const result of data.results) {
      if (
        !lastSyncedAt ||
        new Date(result.last_edited_time) > new Date(lastSyncedAt)
      ) {
        pages.push(result);
      }
    }

    cursor = data.next_cursor ?? undefined;
  } while (cursor);

  return pages;
}

// ---------------------------------------------------------------------------
// Query pages from a specific Notion database
// ---------------------------------------------------------------------------

async function queryDatabase(
  databaseId: string,
  token: string,
  lastSyncedAt?: string
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: PAGE_SIZE };
    if (cursor) body.start_cursor = cursor;

    const data = await notionFetch<{ results: NotionPage[]; next_cursor: string | null; has_more: boolean }>(
      `/databases/${databaseId}/query`,
      token,
      { method: "POST", body: JSON.stringify(body) }
    );

    for (const page of data.results) {
      if (
        !lastSyncedAt ||
        new Date(page.last_edited_time) > new Date(lastSyncedAt)
      ) {
        pages.push(page);
      }
    }

    cursor = data.next_cursor ?? undefined;
  } while (cursor);

  return pages;
}

// ---------------------------------------------------------------------------
// Fetch a single page object
// ---------------------------------------------------------------------------

async function fetchPage(pageId: string, token: string): Promise<NotionPage> {
  return notionFetch<NotionPage>(`/pages/${pageId}`, token);
}

// ---------------------------------------------------------------------------
// NotionConnector
// ---------------------------------------------------------------------------

export class NotionConnector {
  // -------------------------------------------------------------------------
  // validateConfig
  // -------------------------------------------------------------------------
  validateConfig(config: NotionConfig): { valid: boolean; error?: string } {
    if (!config.integrationToken?.startsWith("secret_")) {
      return {
        valid: false,
        error:
          'integrationToken must be a valid Notion Integration Token starting with "secret_".',
      };
    }
    return { valid: true };
  }

  // -------------------------------------------------------------------------
  // testConnection — verifies the token by hitting /users/me
  // -------------------------------------------------------------------------
  async testConnection(
    config: NotionConfig
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await notionFetch<unknown>("/users/me", config.integrationToken);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // sync — primary entry point
  // -------------------------------------------------------------------------
  async sync(
    config: KnowledgeConnectorConfig & { notion: NotionConfig },
    checkpoint?: NotionCheckpoint
  ): Promise<KnowledgeConnectorResult> {
    const { integrationToken, databaseIds, pageIds } = config.notion;
    const lastSyncedAt = checkpoint?.lastSyncedAt;
    const documents: KnowledgeConnectorResult["documents"] = [];
    const errors: string[] = [];
    const syncedAt = new Date().toISOString();

    try {
      let pagesToSync: NotionPage[] = [];

      // -----------------------------------------------------------------------
      // 1) Explicit pageIds take precedence when provided
      // -----------------------------------------------------------------------
      if (pageIds && pageIds.length > 0) {
        for (const pid of pageIds) {
          try {
            const page = await fetchPage(pid, integrationToken);
            if (
              !lastSyncedAt ||
              new Date(page.last_edited_time) > new Date(lastSyncedAt)
            ) {
              pagesToSync.push(page);
            }
          } catch (err) {
            errors.push(
              `Failed to fetch page ${pid}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      // -----------------------------------------------------------------------
      // 2) databaseIds — query each database
      // -----------------------------------------------------------------------
      if (databaseIds && databaseIds.length > 0) {
        for (const dbId of databaseIds) {
          try {
            const dbPages = await queryDatabase(dbId, integrationToken, lastSyncedAt);
            pagesToSync.push(...dbPages);
          } catch (err) {
            errors.push(
              `Failed to query database ${dbId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      // -----------------------------------------------------------------------
      // 3) Full-workspace search (when neither pageIds nor databaseIds given)
      // -----------------------------------------------------------------------
      if ((!pageIds || pageIds.length === 0) && (!databaseIds || databaseIds.length === 0)) {
        pagesToSync = await searchAllPages(integrationToken, lastSyncedAt);
      }

      // -----------------------------------------------------------------------
      // Deduplicate by page id
      // -----------------------------------------------------------------------
      const seen = new Set<string>();
      pagesToSync = pagesToSync.filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });

      // -----------------------------------------------------------------------
      // Fetch block content and build documents
      // -----------------------------------------------------------------------
      for (const page of pagesToSync) {
        try {
          const title = extractPageTitle(page);
          const content = await fetchBlocksAsMarkdown(page.id, integrationToken, 1);

          documents.push({
            id: page.id,
            title,
            content: content.trim(),
            url: page.url,
            createdAt: page.created_time,
            updatedAt: page.last_edited_time,
            metadata: {
              source: "notion",
              pageId: page.id,
            },
          });
        } catch (err) {
          errors.push(
            `Failed to fetch content for page ${page.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } catch (err) {
      errors.push(
        `Notion sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      documents,
      errors,
      checkpoint: { lastSyncedAt: syncedAt } satisfies NotionCheckpoint,
    };
  }
}
