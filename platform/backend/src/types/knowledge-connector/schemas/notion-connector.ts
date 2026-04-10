import { z } from 'zod';
import { KnowledgeConnectorType } from '../index';

export const NotionConfigSchema = z.object({
  type: z.literal(KnowledgeConnectorType.Notion),
  integrationToken: z.string().startsWith('secret_', 'Notion integration token must start with "secret_"'),
  databaseIds: z.array(z.string()).optional(),
  pageIds: z.array(z.string()).optional(),
});

export const NotionCheckpointSchema = z.object({
  type: z.literal(KnowledgeConnectorType.Notion),
  lastSyncedAt: z.string().datetime(), // ISO 8601 string
  syncedPages: z.array(z.string()).optional(), // Optional list of page IDs that were successfully synced
});
