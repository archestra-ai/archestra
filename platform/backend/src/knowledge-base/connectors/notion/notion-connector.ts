import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  NotionCheckpoint,
  NotionConfig,
} from "@/types";
import { NotionConfigSchema } from "@/types";
import { BaseConnector, buildCheckpoint } from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;
const NOTION_API_VERSION = "2022-06-28";
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
        error: "Invalid Notion configuration: a valid Notion API URL is required",
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

    try {
      const response = await this.fetchWithRetry(
        `${parsed.notionApiUrl}/v1/users/me`,
        {
          headers: buildNotionHeaders(params.credentials.apiToken),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `Connection failed (HTTP ${response.status}): ${body}`,
        };
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      // If specific page/database IDs are provided, we can estimate from those
      const pageCount = parsed.pageIds?.length ?? 0;
      const dbCount = parsed.databaseIds?.length ?? 0;

      if (pageCount > 0 || dbCount > 0) {
        // Rough estimate: each database has ~100 entries on average
        return pageCount + dbCount * 100;
      }

      // For full workspace search, do a single request to see if we get a count
      const response = await this.fetchWithRetry(
        `${parsed.notionApiUrl}/v1/search`,
        {
          method: "POST",
          headers: buildNotionHeaders(params.credentials.apiToken),
          body: JSON.stringify({ page_size: 1 }),
        },
      );

      if (!response.ok) return null;

      // Notion search doesn't return total count, so we can't estimate
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

    const checkpoint = (params.checkpoint as NotionCheckpoint | null) ?? {
      type: "notion" as const,
    };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const apiToken = params.credentials.apiToken;
    const baseUrl = parsed.notionApiUrl;

    this.log.debug(
      {
        baseUrl,
        databaseIds: parsed.databaseIds,
        pageIds: parsed.pageIds,
        checkpoint,
      },
      "Starting Notion sync",
    );

    // Sync specific pages first
    if (parsed.pageIds && parsed.pageIds.length > 0) {
      yield* this.syncPages(parsed.pageIds, baseUrl, apiToken, checkpoint);
    }

    // Sync specific databases
    if (parsed.databaseIds && parsed.databaseIds.length > 0) {
      yield* this.syncDatabases(
        parsed.databaseIds,
        baseUrl,
        apiToken,
        batchSize,
        checkpoint,
      );
    }

    // If no specific IDs, do full workspace search
    if (!parsed.pageIds?.length && !parsed.databaseIds?.length) {
      yield* this.syncWorkspace(baseUrl, apiToken, batchSize, checkpoint);
    }
  }

  private async *syncPages(
    pageIds: string[],
    baseUrl: string,
    apiToken: string,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const documents: ConnectorDocument[] = [];
    let lastUpdatedAt: string | undefined;

    for (const pageId of pageIds) {
      await this.rateLimit();

      const doc = await this.safeItemFetch({
        fetch: () => this.fetchPage(pageId, baseUrl, apiToken),
        fallback: null,
        itemId: pageId,
        resource: "page",
      });

      if (doc) {
        // Skip if not updated since last sync
        if (
          checkpoint.lastSyncedAt &&
          doc.updatedAt &&
          doc.updatedAt <= new Date(checkpoint.lastSyncedAt)
        ) {
          continue;
        }
        documents.push(doc);
        if (doc.updatedAt) {
          lastUpdatedAt = doc.updatedAt.toISOString();
        }
      }
    }

    yield {
      documents,
      failures: this.flushFailures(),
      checkpoint: buildCheckpoint({
        type: "notion",
        itemUpdatedAt: lastUpdatedAt,
        previousLastSyncedAt: checkpoint.lastSyncedAt,
      }),
      hasMore: false,
    };
  }

  private async *syncDatabases(
    databaseIds: string[],
    baseUrl: string,
    apiToken: string,
    batchSize: number,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    for (const dbId of databaseIds) {
      let hasMore = true;
      let startCursor: string | undefined;

      while (hasMore) {
        await this.rateLimit();

        const filter = checkpoint.lastSyncedAt
          ? {
              timestamp: "last_edited_time",
              last_edited_time: { after: checkpoint.lastSyncedAt },
            }
          : undefined;

        const response = await this.fetchWithRetry(
          `${baseUrl}/v1/databases/${dbId}/query`,
          {
            method: "POST",
            headers: buildNotionHeaders(apiToken),
            body: JSON.stringify({
              page_size: batchSize,
              ...(startCursor && { start_cursor: startCursor }),
              ...(filter && { filter }),
              sorts: [
                { timestamp: "last_edited_time", direction: "ascending" },
              ],
            }),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          this.log.error(
            { databaseId: dbId, status: response.status, body },
            "Failed to query database",
          );
          throw new Error(
            `Failed to query Notion database ${dbId}: HTTP ${response.status}`,
          );
        }

        // biome-ignore lint/suspicious/noExplicitAny: Notion API response
        const data: any = await response.json();
        const results = data.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of results) {
          const doc = await this.safeItemFetch({
            fetch: () =>
              this.pageResultToDocument(page, baseUrl, apiToken, dbId),
            fallback: null,
            itemId: page.id,
            resource: "database-page",
          });
          if (doc) {
            documents.push(doc);
          }
        }

        hasMore = data.has_more === true;
        startCursor = data.next_cursor ?? undefined;

        const lastPage = results[results.length - 1];
        const lastEditedTime: string | undefined =
          lastPage?.last_edited_time;

        this.log.debug(
          {
            databaseId: dbId,
            pageCount: results.length,
            documentCount: documents.length,
            hasMore,
          },
          "Database batch fetched",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastEditedTime,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore,
        };
      }
    }
  }

  private async *syncWorkspace(
    baseUrl: string,
    apiToken: string,
    batchSize: number,
    checkpoint: NotionCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    let hasMore = true;
    let startCursor: string | undefined;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        page_size: batchSize,
        filter: { value: "page", property: "object" },
      };
      if (startCursor) {
        body.start_cursor = startCursor;
      }
      if (checkpoint.lastSyncedAt) {
        body.sort = {
          direction: "ascending",
          timestamp: "last_edited_time",
        };
      }

      const response = await this.fetchWithRetry(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: buildNotionHeaders(apiToken),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const responseBody = await response.text();
        this.log.error(
          { status: response.status, body: responseBody, batchIndex },
          "Workspace search failed",
        );
        throw new Error(
          `Notion workspace search failed: HTTP ${response.status}`,
        );
      }

      // biome-ignore lint/suspicious/noExplicitAny: Notion API response
      const data: any = await response.json();
      const results = data.results ?? [];
      const documents: ConnectorDocument[] = [];

      for (const page of results) {
        // Skip pages not updated since last sync
        if (
          checkpoint.lastSyncedAt &&
          page.last_edited_time &&
          page.last_edited_time <= checkpoint.lastSyncedAt
        ) {
          continue;
        }

        const doc = await this.safeItemFetch({
          fetch: () => this.pageResultToDocument(page, baseUrl, apiToken),
          fallback: null,
          itemId: page.id,
          resource: "page",
        });
        if (doc) {
          documents.push(doc);
        }
      }

      hasMore = data.has_more === true;
      startCursor = data.next_cursor ?? undefined;

      const lastPage = results[results.length - 1];
      const lastEditedTime: string | undefined = lastPage?.last_edited_time;

      this.log.debug(
        {
          batchIndex,
          pageCount: results.length,
          documentCount: documents.length,
          hasMore,
        },
        "Workspace batch fetched",
      );

      batchIndex++;
      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastEditedTime,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async fetchPage(
    pageId: string,
    baseUrl: string,
    apiToken: string,
  ): Promise<ConnectorDocument | null> {
    const response = await this.fetchWithRetry(
      `${baseUrl}/v1/pages/${pageId}`,
      { headers: buildNotionHeaders(apiToken) },
    );

    if (!response.ok) {
      this.log.warn(
        { pageId, status: response.status },
        "Failed to fetch page",
      );
      return null;
    }

    // biome-ignore lint/suspicious/noExplicitAny: Notion API response
    const page: any = await response.json();
    return this.pageResultToDocument(page, baseUrl, apiToken);
  }

  private async pageResultToDocument(
    // biome-ignore lint/suspicious/noExplicitAny: Notion API response
    page: any,
    baseUrl: string,
    apiToken: string,
    databaseId?: string,
  ): Promise<ConnectorDocument | null> {
    const title = extractPageTitle(page);
    const content = await this.fetchBlockContent(
      page.id,
      baseUrl,
      apiToken,
      0,
    );
    const fullContent = `# ${title}\n\n${content}`;

    return {
      id: page.id,
      title,
      content: fullContent,
      sourceUrl: page.url ?? undefined,
      metadata: {
        pageId: page.id,
        ...(databaseId && { databaseId }),
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
        createdBy: page.created_by?.id,
        lastEditedBy: page.last_edited_by?.id,
        parentType: page.parent?.type,
      },
      updatedAt: page.last_edited_time
        ? new Date(page.last_edited_time)
        : undefined,
    };
  }

  private async fetchBlockContent(
    blockId: string,
    baseUrl: string,
    apiToken: string,
    depth: number,
  ): Promise<string> {
    if (depth >= MAX_BLOCK_DEPTH) return "";

    let allBlocks: unknown[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      await this.rateLimit();

      const url = startCursor
        ? `${baseUrl}/v1/blocks/${blockId}/children?page_size=100&start_cursor=${startCursor}`
        : `${baseUrl}/v1/blocks/${blockId}/children?page_size=100`;

      const response = await this.fetchWithRetry(url, {
        headers: buildNotionHeaders(apiToken),
      });

      if (!response.ok) break;

      // biome-ignore lint/suspicious/noExplicitAny: Notion API response
      const data: any = await response.json();
      allBlocks = allBlocks.concat(data.results ?? []);
      hasMore = data.has_more === true;
      startCursor = data.next_cursor ?? undefined;
    }

    const parts: string[] = [];

    for (const block of allBlocks) {
      // biome-ignore lint/suspicious/noExplicitAny: Notion block types
      const b = block as any;
      const text = blockToMarkdown(b);
      if (text) parts.push(text);

      // Recursively fetch children if the block has them
      if (b.has_children) {
        const childContent = await this.fetchBlockContent(
          b.id,
          baseUrl,
          apiToken,
          depth + 1,
        );
        if (childContent) parts.push(childContent);
      }
    }

    return parts.join("\n");
  }
}

// ===== Module-level helpers =====

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}

function buildNotionHeaders(
  apiToken: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Notion API page object
function extractPageTitle(page: any): string {
  const properties = page.properties ?? {};

  // Try common title property names
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t: { plain_text: string }) => t.plain_text).join("") || "Untitled";
    }
  }

  return "Untitled";
}

// biome-ignore lint/suspicious/noExplicitAny: Notion block types vary widely
function blockToMarkdown(block: any): string {
  const type: string = block.type;
  const data = block[type];
  if (!data) return "";

  const richTextToString = (richText: unknown[]): string => {
    if (!Array.isArray(richText)) return "";
    return richText
      .map((t: { plain_text?: string }) => t.plain_text ?? "")
      .join("");
  };

  switch (type) {
    case "paragraph":
      return richTextToString(data.rich_text);
    case "heading_1":
      return `# ${richTextToString(data.rich_text)}`;
    case "heading_2":
      return `## ${richTextToString(data.rich_text)}`;
    case "heading_3":
      return `### ${richTextToString(data.rich_text)}`;
    case "bulleted_list_item":
      return `- ${richTextToString(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToString(data.rich_text)}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${richTextToString(data.rich_text)}`;
    case "toggle":
      return richTextToString(data.rich_text);
    case "quote":
      return `> ${richTextToString(data.rich_text)}`;
    case "callout":
      return `> ${richTextToString(data.rich_text)}`;
    case "code":
      return `\`\`\`${data.language ?? ""}\n${richTextToString(data.rich_text)}\n\`\`\``;
    case "divider":
      return "---";
    case "table_row":
      if (Array.isArray(data.cells)) {
        return data.cells
          .map((cell: unknown[]) => richTextToString(cell))
          .join("\t");
      }
      return "";
    case "bookmark":
      return data.url ?? "";
    case "embed":
      return data.url ?? "";
    case "image":
      return data.file?.url ?? data.external?.url ?? "";
    case "equation":
      return data.expression ?? "";
    default:
      // For unsupported block types, try to extract rich_text if available
      if (data.rich_text) {
        return richTextToString(data.rich_text);
      }
      return "";
  }
}
