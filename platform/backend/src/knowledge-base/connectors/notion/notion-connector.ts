import { Client } from "@notionhq/client";
import {
  BlockObjectResponse,
  GetPageResponse,
  ListBlockChildrenResponse,
  PageObjectResponse,
  QueryDatabaseResponse,
  SearchResponse,
} from "@notionhq/client/build/src/api-endpoints";
import {
  ConnectorSyncResult,
  KnowledgeDocument,
  NotionConnectorConfig,
} from "../../types/knowledge-connector";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPlainText(
  richText: Array<{ plain_text: string }> | undefined
): string {
  if (!richText) return "";
  return richText.map((t) => t.plain_text).join("");
}

function getPageTitle(page: PageObjectResponse): string {
  const props = page.properties;
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title") {
      return getPlainText(prop.title);
    }
  }
  return page.id;
}

// ---------------------------------------------------------------------------
// Block → Markdown conversion
// ---------------------------------------------------------------------------

function blockToMarkdown(block: BlockObjectResponse, depth = 0): string {
  const indent = "  ".repeat(depth);
  const type = block.type as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (block as any)[type];

  switch (type) {
    case "paragraph":
      return `${indent}${getPlainText(data?.rich_text)}\n\n`;

    case "heading_1":
      return `# ${getPlainText(data?.rich_text)}\n\n`;

    case "heading_2":
      return `## ${getPlainText(data?.rich_text)}\n\n`;

    case "heading_3":
      return `### ${getPlainText(data?.rich_text)}\n\n`;

    case "bulleted_list_item":
      return `${indent}- ${getPlainText(data?.rich_text)}\n`;

    case "numbered_list_item":
      return `${indent}1. ${getPlainText(data?.rich_text)}\n`;

    case "to_do": {
      const checked = data?.checked ? "[x]" : "[ ]";
      return `${indent}- ${checked} ${getPlainText(data?.rich_text)}\n`;
    }

    case "toggle":
      return `${indent}> ${getPlainText(data?.rich_text)}\n`;

    case "quote":
      return `${indent}> ${getPlainText(data?.rich_text)}\n\n`;

    case "callout":
      return `${indent}> **${getPlainText(data?.rich_text)}**\n\n`;

    case "code": {
      const lang = data?.language ?? "";
      const code = getPlainText(data?.rich_text);
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }

    case "divider":
      return `---\n\n`;

    case "image": {
      const url =
        data?.type === "external" ? data.external?.url : data?.file?.url;
      const caption = getPlainText(data?.caption);
      return `![${caption}](${url ?? ""})\n\n`;
    }

    case "equation":
      return `$$${data?.expression ?? ""}$$\n\n`;

    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Notion API wrapper
// ---------------------------------------------------------------------------

class NotionClient {
  private client: Client;

  constructor(apiKey: string) {
    this.client = new Client({ auth: apiKey });
  }

  async searchPages(query = ""): Promise<PageObjectResponse[]> {
    const results: PageObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response: SearchResponse = await this.client.search({
        query,
        filter: { property: "object", value: "page" },
        start_cursor: cursor,
        page_size: 100,
      });

      for (const result of response.results) {
        if (result.object === "page") {
          results.push(result as PageObjectResponse);
        }
      }

      cursor = response.next_cursor ?? undefined;
    } while (cursor);

    return results;
  }

  async getPage(pageId: string): Promise<GetPageResponse> {
    return this.client.pages.retrieve({ page_id: pageId });
  }

  async queryDatabase(databaseId: string): Promise<PageObjectResponse[]> {
    const results: PageObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response: QueryDatabaseResponse =
        await this.client.databases.query({
          database_id: databaseId,
          start_cursor: cursor,
          page_size: 100,
        });

      for (const result of response.results) {
        if (result.object === "page") {
          results.push(result as PageObjectResponse);
        }
      }

      cursor = response.next_cursor ?? undefined;
    } while (cursor);

    return results;
  }

  async getBlockChildren(blockId: string): Promise<BlockObjectResponse[]> {
    const results: BlockObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response: ListBlockChildrenResponse =
        await this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        });

      for (const block of response.results) {
        if ("type" in block) {
          results.push(block as BlockObjectResponse);
        }
      }

      cursor = response.next_cursor ?? undefined;
    } while (cursor);

    return results;
  }
}

// ---------------------------------------------------------------------------
// Recursive block fetcher
// ---------------------------------------------------------------------------

async function fetchBlocksRecursively(
  client: NotionClient,
  blockId: string,
  depth = 0
): Promise<{ block: BlockObjectResponse; depth: number }[]> {
  const blocks = await client.getBlockChildren(blockId);
  const result: { block: BlockObjectResponse; depth: number }[] = [];

  for (const block of blocks) {
    result.push({ block, depth });
    if (block.has_children) {
      const children = await fetchBlocksRecursively(client, block.id, depth + 1);
      result.push(...children);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Page → KnowledgeDocument
// ---------------------------------------------------------------------------

async function pageToDocument(
  client: NotionClient,
  page: PageObjectResponse
): Promise<KnowledgeDocument> {
  const blocks = await fetchBlocksRecursively(client, page.id);
  const markdown = blocks
    .map(({ block, depth }) => blockToMarkdown(block, depth))
    .join("");

  const title = getPageTitle(page);
  const url = page.url;
  const lastEditedTime = page.last_edited_time;

  return {
    id: page.id,
    title,
    content: markdown,
    url,
    metadata: {
      source: "notion",
      pageId: page.id,
      lastEditedTime,
    },
    updatedAt: new Date(lastEditedTime),
  };
}

// ---------------------------------------------------------------------------
// NotionConnector
// ---------------------------------------------------------------------------

export class NotionConnector {
  private client: NotionClient;

  constructor(private config: NotionConnectorConfig) {
    this.client = new NotionClient(config.apiKey);
  }

  async sync(): Promise<ConnectorSyncResult> {
    const documents: KnowledgeDocument[] = [];
    const errors: string[] = [];

    try {
      if (
        this.config.pageIds &&
        this.config.pageIds.length > 0
      ) {
        // Sync specific pages by ID
        await this.syncExplicitPages(documents, errors);
      } else if (
        this.config.databaseIds &&
        this.config.databaseIds.length > 0
      ) {
        // Sync all pages in specific databases
        await this.syncDatabases(documents, errors);
      } else {
        // Sync all accessible pages
        await this.syncAllPages(documents, errors);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      errors.push(`Notion sync failed: ${message}`);
    }

    return { documents, errors };
  }

  private async syncExplicitPages(
    documents: KnowledgeDocument[],
    errors: string[]
  ): Promise<void> {
    for (const pageId of this.config.pageIds ?? []) {
      try {
        const page = (await this.client.getPage(pageId)) as PageObjectResponse;
        const doc = await pageToDocument(this.client, page);
        documents.push(doc);
      } catch (error) {
        // Log pages we can't access so partial syncs are visible
        const message =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `Failed to fetch Notion page with id ${pageId}:`,
          message
        );
        errors.push(`Failed to fetch page ${pageId}: ${message}`);
      }
    }
  }

  private async syncDatabases(
    documents: KnowledgeDocument[],
    errors: string[]
  ): Promise<void> {
    for (const databaseId of this.config.databaseIds ?? []) {
      try {
        const pages = await this.client.queryDatabase(databaseId);
        for (const page of pages) {
          try {
            const doc = await pageToDocument(this.client, page);
            documents.push(doc);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn(
              `Failed to process Notion page ${page.id} from database ${databaseId}:`,
              message
            );
            errors.push(
              `Failed to process page ${page.id} in database ${databaseId}: ${message}`
            );
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `Failed to query Notion database ${databaseId}:`,
          message
        );
        errors.push(`Failed to query database ${databaseId}: ${message}`);
      }
    }
  }

  private async syncAllPages(
    documents: KnowledgeDocument[],
    errors: string[]
  ): Promise<void> {
    try {
      const pages = await this.client.searchPages();
      for (const page of pages) {
        try {
          const doc = await pageToDocument(this.client, page);
          documents.push(doc);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `Failed to process Notion page ${page.id}:`,
            message
          );
          errors.push(`Failed to process page ${page.id}: ${message}`);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search Notion pages: ${message}`);
    }
  }
}
