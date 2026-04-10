import { z } from 'zod';
import { IKnowledgeConnector } from '../connector.interface';
import {
  KnowledgeConnectorTestResult,
  NotionConfig,
  NotionCheckpoint,
  KnowledgeConnectorType,
} from '@/types/knowledge-connector';
import { logger } from '@/lib/logger';
import { createMarkdownBlock } from './notion-markdown';

const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2022-06-28'; // Ensure compatibility with block parsing

type NotionAPIHeaders = {
  'Notion-Version': string;
  Authorization: string;
  'Content-Type': 'application/json';
};

interface NotionPage {
  object: 'page';
  id: string;
  properties: {
    title?: {
      title: Array<{ plain_text: string }>;
    };
  };
  last_edited_time: string;
  url: string;
  parent: {
    type: 'database_id' | 'page_id' | 'workspace';
    database_id?: string;
    page_id?: string;
  };
}

interface NotionDatabase {
  object: 'database';
  id: string;
  title: Array<{ plain_text: string }>;
  last_edited_time: string;
  url: string;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  parent: {
    type: string;
    page_id?: string;
    database_id?: string;
  };
  [key: string]: any; // Allows for different block properties
}

export class NotionConnector implements IKnowledgeConnector<NotionConfig, NotionCheckpoint> {
  readonly type = KnowledgeConnectorType.Notion;

  private getHeaders(token: string): NotionAPIHeaders {
    return {
      'Notion-Version': NOTION_API_VERSION,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async validateConfig(config: NotionConfig): Promise<z.ZodIssue[] | null> {
    try {
      // Basic validation handled by Zod schema, but we can add more complex checks here if needed
      // For now, Zod schema is sufficient.
      return null;
    } catch (error: any) {
      logger.error('Notion connector config validation failed:', error);
      return [{ message: error.message || 'Invalid Notion configuration', path: [], code: 'custom' }];
    }
  }

  async testConnection(config: NotionConfig): Promise<KnowledgeConnectorTestResult> {
    try {
      const headers = this.getHeaders(config.integrationToken);
      const response = await fetch(`${NOTION_API_BASE_URL}/users`, { headers });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Notion API connection test failed: ${response.status} - ${errorText}`);
        return { success: false, message: `Failed to connect to Notion: ${errorText}` };
      }

      const data = await response.json();
      if (!Array.isArray(data.results)) {
        return { success: false, message: 'Invalid response from Notion API.' };
      }

      return { success: true, message: 'Successfully connected to Notion API.' };
    } catch (error: any) {
      logger.error('Error testing Notion connection:', error);
      return { success: false, message: `Error testing Notion connection: ${error.message}` };
    }
  }

  async sync(
    config: NotionConfig,
    checkpoint: NotionCheckpoint | null,
    onDocumentUpdate: (document: any) => Promise<void>,
    onCheckpointUpdate: (newCheckpoint: NotionCheckpoint) => Promise<void>
  ): Promise<void> {
    logger.info(`Starting Notion sync for connector with config: ${JSON.stringify(config)}`);

    const headers = this.getHeaders(config.integrationToken);
    const lastSyncedAt = checkpoint?.lastSyncedAt ? new Date(checkpoint.lastSyncedAt) : null;
    const syncedPageIds: Set<string> = new Set(checkpoint?.syncedPages || []);

    let allDiscoveredPages: NotionPage[] = [];

    // Prioritize explicit pageIds and databaseIds
    if (config.pageIds && config.pageIds.length > 0) {
      for (const pageId of config.pageIds) {
        try {
          const page = await this.fetchNotionPage(pageId, headers);
          if (page) {
            allDiscoveredPages.push(page);
          }
        } catch (error) {
          logger.warn(`Could not fetch explicit page ID ${pageId}: ${error}`);
        }
      }
    }

    if (config.databaseIds && config.databaseIds.length > 0) {
      for (const dbId of config.databaseIds) {
        try {
          const pagesInDb = await this.queryNotionDatabase(dbId, headers);
          allDiscoveredPages.push(...pagesInDb);
        } catch (error) {
          logger.warn(`Could not query explicit database ID ${dbId}: ${error}`);
        }
      }
    }

    // Full workspace search if no specific pageIds or databaseIds are provided
    if (!config.pageIds?.length && !config.databaseIds?.length) {
      try {
        const searchResults = await this.searchNotionWorkspace(headers, lastSyncedAt);
        allDiscoveredPages.push(...searchResults);
      } catch (error) {
        logger.error(`Error during full Notion workspace search: ${error}`);
      }
    }

    const uniquePagesMap = new Map<string, NotionPage>();
    for (const page of allDiscoveredPages) {
      if (!uniquePagesMap.has(page.id) || new Date(page.last_edited_time) > new Date(uniquePagesMap.get(page.id)!.last_edited_time)) {
        uniquePagesMap.set(page.id, page);
      }
    }
    const pagesToSync = Array.from(uniquePagesMap.values());

    logger.info(`Found ${pagesToSync.length} unique pages to consider for sync.`);

    for (const page of pagesToSync) {
      const pageLastEditedTime = new Date(page.last_edited_time);

      // Incremental sync logic
      if (lastSyncedAt && pageLastEditedTime <= lastSyncedAt && syncedPageIds.has(page.id)) {
        logger.debug(`Skipping page ${page.id} (title: ${this.getPageTitle(page)}) as it hasn't been updated since last sync.`);
        continue;
      }

      try {
        const pageContent = await this.fetchPageContent(page, headers);
        const markdownContent = pageContent.blocks.map(block => createMarkdownBlock(block)).join('\n\n');

        const document = {
          id: page.id,
          title: pageContent.title,
          content: markdownContent,
          url: page.url,
          source: KnowledgeConnectorType.Notion,
          lastModified: page.last_edited_time,
          metadata: {
            page_id: page.id,
            url: page.url,
            // Add parent database/page ID if available
            parent_type: page.parent?.type,
            parent_id: page.parent?.page_id || page.parent?.database_id,
          },
        };

        await onDocumentUpdate(document);
        syncedPageIds.add(page.id);
        logger.debug(`Synced page: ${page.id} - ${pageContent.title}`);
      } catch (error) {
        logger.error(`Error syncing Notion page ${page.id} (title: ${this.getPageTitle(page)}): ${error}`);
      }
    }

    const newCheckpoint: NotionCheckpoint = {
      lastSyncedAt: new Date().toISOString(),
      syncedPages: Array.from(syncedPageIds),
    };
    await onCheckpointUpdate(newCheckpoint);
    logger.info('Notion sync completed.');
  }

  private getPageTitle(page: NotionPage): string {
    return page.properties?.title?.title?.[0]?.plain_text || 'Untitled Page';
  }

  private async fetchNotionPage(pageId: string, headers: NotionAPIHeaders): Promise<NotionPage | null> {
    const response = await fetch(`${NOTION_API_BASE_URL}/pages/${pageId}`, { headers });
    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(`Notion page not found: ${pageId}`);
        return null;
      }
      throw new Error(`Failed to fetch Notion page ${pageId}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as NotionPage;
  }

  private async queryNotionDatabase(databaseId: string, headers: NotionAPIHeaders): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let nextCursor: string | null = null;
    do {
      const body: any = {
        filter: {
          // No specific filter needed here, fetching all pages from the database
          // You might add filters based on Notion database properties if needed
        },
      };
      if (nextCursor) {
        body.start_cursor = nextCursor;
      }

      const response = await fetch(`${NOTION_API_BASE_URL}/databases/${databaseId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to query Notion database ${databaseId}: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      pages.push(...(data.results.filter((item: any) => item.object === 'page') as NotionPage[]));
      nextCursor = data.next_cursor;
    } while (nextCursor);
    return pages;
  }

  private async searchNotionWorkspace(headers: NotionAPIHeaders, lastSyncedAt: Date | null): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let nextCursor: string | null = null;
    do {
      const body: any = {
        filter: {
          property: 'object',
          value: 'page',
        },
        sort: {
          direction: 'descending',
          property: 'last_edited_time',
        },
      };
      if (nextCursor) {
        body.start_cursor = nextCursor;
      }

      const response = await fetch(`${NOTION_API_BASE_URL}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to search Notion workspace: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      pages.push(...(data.results.filter((item: any) => item.object === 'page') as NotionPage[]));
      nextCursor = data.next_cursor;

      // Stop searching if we hit pages older than lastSyncedAt for full workspace sync
      if (lastSyncedAt) {
        const oldestPageInBatch = pages[pages.length - 1];
        if (oldestPageInBatch && new Date(oldestPageInBatch.last_edited_time) <= lastSyncedAt) {
          logger.debug('Reached pages older than lastSyncedAt during search, stopping.');
          break;
        }
      }

    } while (nextCursor);

    // Filter out pages that might be databases' children and thus already covered by database query
    // This is a rough filter; ideally we would track parent relations more explicitly.
    // For now, uniquePagesMap handles true uniqueness by ID.
    return pages.filter(page => page.parent.type !== 'database_id');
  }

  private async fetchBlockChildren(blockId: string, headers: NotionAPIHeaders, depth: number = 0): Promise<NotionBlock[]> {
    if (depth >= 3) {
      return []; // Max recursion depth
    }

    const blocks: NotionBlock[] = [];
    let nextCursor: string | null = null;
    do {
      const url = new URL(`${NOTION_API_BASE_URL}/blocks/${blockId}/children`);
      if (nextCursor) {
        url.searchParams.set('start_cursor', nextCursor);
      }
      url.searchParams.set('page_size', '100'); // Fetch up to 100 blocks at once

      const response = await fetch(url.toString(), { headers });
      if (!response.ok) {
        // Log and continue, don't fail entire sync for one block
        logger.warn(`Failed to fetch children for block ${blockId}: ${response.status} ${await response.text()}`);
        return blocks;
      }
      const data = await response.json();
      blocks.push(...(data.results as NotionBlock[]));
      nextCursor = data.next_cursor;
    } while (nextCursor);

    // Recursively fetch children of children
    for (const block of blocks) {
      if (block.has_children) {
        const childBlocks = await this.fetchBlockChildren(block.id, headers, depth + 1);
        // Attach children to the parent block for easier markdown conversion
        (block as any).children = childBlocks;
      }
    }
    return blocks;
  }

  private async fetchPageContent(page: NotionPage, headers: NotionAPIHeaders): Promise<{ title: string; blocks: NotionBlock[] }> {
    const pageTitle = this.getPageTitle(page);
    const blocks = await this.fetchBlockChildren(page.id, headers);
    return { title: pageTitle, blocks };
  }
}
