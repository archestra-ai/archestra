import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
  PartialBlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints/blocks";
import type {
  PageObjectResponse,
  PartialPageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints/common";
import type { SearchResponse } from "@notionhq/client/build/src/api-endpoints/search";
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

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";
const DEFAULT_BATCH_SIZE = 50;
const MAX_BLOCK_DEPTH = 3;
// Subtract 5 min from syncFrom to guard against clock skew between Notion
// servers and our system, so we never skip a page that was edited right
// around the checkpoint boundary.
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// Notion's REST API still exposes POST /databases/:id/query but the v5 SDK
// dropped the method, so we call it via fetchWithRetry and type the response
// ourselves.
type NotionDatabaseQueryResponse = {
  object: "list";
  results: Array<
    | PageObjectResponse
    | PartialPageObjectResponse
    | { object: string; id: string }
  >;
  next_cursor: string | null;
  has_more: boolean;
};

export class NotionConnector extends BaseConnector {
  type = "notion" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseNotionConfig,
      label: "Notion",
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    return this.runConnectionTest({
      label: "Notion",
      probe: async () => {
        const response = await this.fetchWithRetry(
          `${NOTION_API_BASE}/users/me`,
          { headers: buildHeaders(params.credentials) },
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
      },
    });
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
    const syncFrom = checkpoint.lastSyncedAt ?? params.startTime?.toISOString();

    this.log.debug(
      { databaseIds: parsed.databaseIds, pageIds: parsed.pageIds, syncFrom },
      "Starting Notion sync",
    );

    // Specific pages: always re-fetch the listed IDs, skip block content if
    // the page has not changed since the last sync.
    if (parsed.pageIds && parsed.pageIds.length > 0) {
      yield* this.syncSpecificPages(
        parsed,
        params.credentials,
        checkpoint,
        syncFrom,
        batchSize,
      );
      return;
    }

    // Database IDs: use Notion's database query endpoint which supports
    // server-side filtering by last_edited_time — true incremental sync.
    if (parsed.databaseIds && parsed.databaseIds.length > 0) {
      yield* this.syncFromDatabases(
        parsed,
        params.credentials,
        checkpoint,
        syncFrom,
        batchSize,
      );
      return;
    }

    // No IDs provided: fall back to the global search API. The search endpoint
    // has no time filter, so we post-filter to skip unchanged pages and avoid
    // unnecessary block-content fetches.
    yield* this.searchAndSyncPages(
      params.credentials,
      checkpoint,
      syncFrom,
      batchSize,
    );
  }

  // ===== Private methods =====

  private async *syncSpecificPages(
    config: NotionConfig,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
    syncFrom: string | undefined,
    batchSize: number,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const pageIds = config.pageIds ?? [];
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;
    let batchIndex = 0;

    for (let i = 0; i < pageIds.length; i += batchSize) {
      const batch = pageIds.slice(i, i + batchSize);
      const documents: ConnectorDocument[] = [];

      for (const pageId of batch) {
        await this.rateLimit();
        const result = await this.safeItemFetch({
          fetch: async () => {
            const page = await this.fetchPage(pageId, credentials);
            if (!page) return null;

            // Skip pages that haven't changed since the last sync entirely.
            // Returning null avoids re-indexing the page with only its title
            // (no body), which would overwrite the previously-stored full
            // content in the knowledge base.
            const isUnchanged =
              safetyBufferedSyncFrom &&
              page.last_edited_time <= safetyBufferedSyncFrom;
            if (isUnchanged) return null;

            const content = await this.fetchPageContent(pageId, credentials);
            return pageToDocument(page, content);
          },
          fallback: null,
          itemId: pageId,
          resource: "page",
        });
        if (result) documents.push(result);
      }

      const hasMore = i + batchSize < pageIds.length;
      const lastDoc = documents[documents.length - 1];

      batchIndex++;
      this.log.debug(
        { batchIndex, documentCount: documents.length, hasMore },
        "Specific pages batch done",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "notion",
          itemUpdatedAt: lastDoc?.updatedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore,
      };
    }
  }

  private async *syncFromDatabases(
    config: NotionConfig,
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
    syncFrom: string | undefined,
    batchSize: number,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const databaseIds = config.databaseIds ?? [];
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;

    for (let dbIndex = 0; dbIndex < databaseIds.length; dbIndex++) {
      const databaseId = databaseIds[dbIndex];
      const isLastDb = dbIndex === databaseIds.length - 1;

      yield* this.queryDatabase({
        databaseId,
        credentials,
        checkpoint,
        syncFrom: safetyBufferedSyncFrom,
        batchSize,
        isLastDb,
      });
    }
  }

  private async *queryDatabase(params: {
    databaseId: string;
    credentials: ConnectorCredentials;
    checkpoint: NotionCheckpoint;
    syncFrom: string | undefined;
    batchSize: number;
    isLastDb: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      databaseId,
      credentials,
      checkpoint,
      syncFrom,
      batchSize,
      isLastDb,
    } = params;
    let cursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { databaseId, batchIndex, cursor, syncFrom },
          "Querying Notion database",
        );

        const queryBody = buildDatabaseQueryBody({
          syncFrom,
          cursor,
          pageSize: batchSize,
        });

        const response = await this.fetchWithRetry(
          `${NOTION_API_BASE}/databases/${databaseId}/query`,
          {
            method: "POST",
            headers: buildHeaders(credentials),
            body: JSON.stringify(queryBody),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Notion database query failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
          );
        }

        const result = (await response.json()) as NotionDatabaseQueryResponse;
        const results = result.results;

        const documents: ConnectorDocument[] = [];

        for (const item of results) {
          if (item.object !== "page" || !isFullPageObject(item)) continue;

          const pageId = item.id;
          const doc = await this.safeItemFetch({
            fetch: async () => {
              const content = await this.fetchPageContent(pageId, credentials);
              return pageToDocument(item, content);
            },
            fallback: null,
            itemId: pageId,
            resource: "page",
          });
          if (doc) documents.push(doc);
        }

        cursor = result.next_cursor ?? undefined;
        // Only set hasMore=true when there are more pages AND it's this DB,
        // so the outer loop can yield the final batch with hasMore=false.
        const dbHasMore = result.has_more === true && !!cursor;
        hasMore = dbHasMore;

        const lastResult = results[results.length - 1];
        const lastEditedAt =
          lastResult && isFullPageObject(lastResult)
            ? lastResult.last_edited_time
            : undefined;

        batchIndex++;
        this.log.debug(
          {
            databaseId,
            batchIndex,
            pageCount: results.length,
            documentCount: documents.length,
            hasMore: dbHasMore,
          },
          "Notion database query batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastEditedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { lastEditedAt: lastEditedAt ?? checkpoint.lastEditedAt },
          }),
          hasMore: dbHasMore || !isLastDb,
        };
      } catch (error) {
        this.log.error(
          { databaseId, batchIndex, error: extractErrorMessage(error) },
          "Notion database query batch failed",
        );
        throw error;
      }
    }
  }

  private async *searchAndSyncPages(
    credentials: ConnectorCredentials,
    checkpoint: NotionCheckpoint,
    syncFrom: string | undefined,
    batchSize: number,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const safetyBufferedSyncFrom = syncFrom
      ? subtractSafetyBuffer(syncFrom)
      : undefined;
    let cursor: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, cursor }, "Fetching Notion search batch");

        const searchBody = buildSearchBody({ cursor, pageSize: batchSize });

        const response = await this.fetchWithRetry(
          `${NOTION_API_BASE}/search`,
          {
            method: "POST",
            headers: buildHeaders(credentials),
            body: JSON.stringify(searchBody),
          },
        );

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Notion search failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
          );
        }

        const result = (await response.json()) as SearchResponse;
        const results = result.results;

        const documents: ConnectorDocument[] = [];

        for (const item of results) {
          if (item.object !== "page" || !isFullPageObject(item)) continue;

          // The search API has no server-side time filter, so post-filter here.
          // Pages that haven't changed since the last sync are skipped to avoid
          // re-fetching block content and re-embedding unchanged documents.
          if (
            safetyBufferedSyncFrom &&
            item.last_edited_time <= safetyBufferedSyncFrom
          ) {
            continue;
          }

          const pageId = item.id;
          const doc = await this.safeItemFetch({
            fetch: async () => {
              const content = await this.fetchPageContent(pageId, credentials);
              return pageToDocument(item, content);
            },
            fallback: null,
            itemId: pageId,
            resource: "page",
          });
          if (doc) documents.push(doc);
        }

        cursor = result.next_cursor ?? undefined;
        hasMore = result.has_more === true && !!cursor;

        // Advance the checkpoint using the last result in the page (not just
        // the last processed doc) so the cursor position advances even when
        // every item in a batch was skipped as unchanged.
        const lastResult = results[results.length - 1];
        const lastEditedAt =
          lastResult && isFullPageObject(lastResult)
            ? lastResult.last_edited_time
            : undefined;

        batchIndex++;
        this.log.debug(
          {
            batchIndex,
            pageCount: results.length,
            documentCount: documents.length,
            hasMore,
          },
          "Notion search batch done",
        );

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "notion",
            itemUpdatedAt: lastEditedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { lastEditedAt: lastEditedAt ?? checkpoint.lastEditedAt },
          }),
          hasMore,
        };
      } catch (error) {
        this.log.error(
          { batchIndex, error: extractErrorMessage(error) },
          "Notion search batch failed",
        );
        throw error;
      }
    }
  }

  private async fetchPage(
    pageId: string,
    credentials: ConnectorCredentials,
  ): Promise<PageObjectResponse | null> {
    const response = await this.fetchWithRetry(
      `${NOTION_API_BASE}/pages/${pageId}`,
      { headers: buildHeaders(credentials) },
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    return (await response.json()) as PageObjectResponse;
  }

  private async fetchPageContent(
    blockId: string,
    credentials: ConnectorCredentials,
    depth = 0,
  ): Promise<string> {
    if (depth >= MAX_BLOCK_DEPTH) return "";

    const parts: string[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      const url = cursor
        ? `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100&start_cursor=${cursor}`
        : `${NOTION_API_BASE}/blocks/${blockId}/children?page_size=100`;

      const response = await this.fetchWithRetry(url, {
        headers: buildHeaders(credentials),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Failed to fetch blocks for ${blockId}: HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const result = (await response.json()) as ListBlockChildrenResponse;

      for (const block of result.results) {
        const text = extractBlockText(block);
        if (text) parts.push(text);

        if (
          block.object === "block" &&
          "has_children" in block &&
          block.has_children &&
          depth < MAX_BLOCK_DEPTH - 1
        ) {
          const childContent = await this.fetchPageContent(
            block.id,
            credentials,
            depth + 1,
          );
          if (childContent) parts.push(childContent);
        }
      }

      cursor = result.next_cursor ?? undefined;
      hasMore = result.has_more === true && !!cursor;
    }

    return parts.join("\n");
  }
}

// ===== Module-level helpers =====

function isFullPageObject(item: {
  object: string;
  id: string;
}): item is PageObjectResponse {
  return "properties" in item && "last_edited_time" in item;
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function buildHeaders(
  credentials: ConnectorCredentials,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function parseNotionConfig(
  config: Record<string, unknown>,
): NotionConfig | null {
  const result = NotionConfigSchema.safeParse({ type: "notion", ...config });
  return result.success ? result.data : null;
}

function buildDatabaseQueryBody(params: {
  syncFrom?: string;
  cursor?: string;
  pageSize: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
    page_size: params.pageSize,
  };

  // Server-side incremental filter — only return pages edited after syncFrom.
  if (params.syncFrom) {
    body.filter = {
      timestamp: "last_edited_time",
      last_edited_time: { after: params.syncFrom },
    };
  }

  if (params.cursor) {
    body.start_cursor = params.cursor;
  }

  return body;
}

function buildSearchBody(params: {
  cursor?: string;
  pageSize: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filter: { value: "page", property: "object" },
    sort: { direction: "ascending", timestamp: "last_edited_time" },
    page_size: params.pageSize,
  };

  if (params.cursor) {
    body.start_cursor = params.cursor;
  }

  return body;
}

function extractPageTitle(page: PageObjectResponse): string {
  const properties = page.properties;

  // Try common title property names first for efficiency
  for (const key of ["title", "Title", "Name", "name"]) {
    const prop = properties[key];
    if (prop && "type" in prop && prop.type === "title" && "title" in prop) {
      const titleProp = prop as {
        type: "title";
        title: Array<RichTextItemResponse>;
      };
      const text = titleProp.title.map((t) => t.plain_text).join("");
      if (text.trim()) return text.trim();
    }
  }

  // Fall back to first title-type property found
  for (const prop of Object.values(properties)) {
    if (prop && "type" in prop && prop.type === "title" && "title" in prop) {
      const titleProp = prop as {
        type: "title";
        title: Array<RichTextItemResponse>;
      };
      const text = titleProp.title.map((t) => t.plain_text).join("");
      if (text.trim()) return text.trim();
    }
  }

  return "Untitled";
}

function extractBlockText(
  block: BlockObjectResponse | PartialBlockObjectResponse,
): string {
  if (!("type" in block)) return "";

  const type = block.type;
  // Access the block-type-specific content by its discriminant key
  type BlockContent = { rich_text?: Array<RichTextItemResponse> };
  const blockData = (block as unknown as Record<string, BlockContent>)[type];
  if (!blockData?.rich_text) return "";

  const text = blockData.rich_text.map((rt) => rt.plain_text).join("");
  if (!text.trim()) return "";

  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    default:
      return text;
  }
}

function pageToDocument(
  page: PageObjectResponse,
  content: string,
): ConnectorDocument {
  const id = page.id;
  const title = extractPageTitle(page);

  const fullContent = content ? `# ${title}\n\n${content}` : `# ${title}`;

  return {
    id,
    title,
    content: fullContent,
    sourceUrl: page.url,
    metadata: {
      notionPageId: id,
      lastEditedTime: page.last_edited_time,
      createdTime: page.created_time,
      archived: page.archived,
    },
    updatedAt: new Date(page.last_edited_time),
  };
}
