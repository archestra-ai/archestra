import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { KnowledgeBaseVisibilitySchema } from "./knowledge-base";
import {
  ConnectorCheckpointSchema,
  ConnectorConfigSchema,
  ConnectorSyncStatusSchema,
  ConnectorTypeSchema,
} from "./knowledge-connector";

// ===== Knowledge Base Schemas =====

export const SelectKnowledgeBaseSchema = createSelectSchema(
  schema.knowledgeBasesTable,
  {
    visibility: KnowledgeBaseVisibilitySchema,
    teamIds: z.array(z.string()),
  },
);
export const InsertKnowledgeBaseSchema = createInsertSchema(
  schema.knowledgeBasesTable,
  {
    visibility: KnowledgeBaseVisibilitySchema.optional(),
    teamIds: z.array(z.string()).optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKnowledgeBaseSchema = createUpdateSchema(
  schema.knowledgeBasesTable,
  {
    visibility: KnowledgeBaseVisibilitySchema.optional(),
    teamIds: z.array(z.string()).optional(),
  },
).pick({
  name: true,
  description: true,
  status: true,
  visibility: true,
  teamIds: true,
});

export type KnowledgeBase = z.infer<typeof SelectKnowledgeBaseSchema>;
export type InsertKnowledgeBase = z.infer<typeof InsertKnowledgeBaseSchema>;
export type UpdateKnowledgeBase = z.infer<typeof UpdateKnowledgeBaseSchema>;

// ===== Knowledge Base Connector Schemas =====

const NullableConnectorSyncStatusSchema = ConnectorSyncStatusSchema.nullable();

export const SelectKnowledgeBaseConnectorSchema = createSelectSchema(
  schema.knowledgeBaseConnectorsTable,
  {
    connectorType: ConnectorTypeSchema,
    config: ConnectorConfigSchema,
    lastSyncStatus: NullableConnectorSyncStatusSchema,
  },
);
export const InsertKnowledgeBaseConnectorSchema = createInsertSchema(
  schema.knowledgeBaseConnectorsTable,
  {
    connectorType: ConnectorTypeSchema,
    config: ConnectorConfigSchema,
    checkpoint: ConnectorCheckpointSchema.optional(),
    lastSyncStatus: NullableConnectorSyncStatusSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKnowledgeBaseConnectorSchema = createUpdateSchema(
  schema.knowledgeBaseConnectorsTable,
  {
    connectorType: ConnectorTypeSchema.optional(),
    config: ConnectorConfigSchema.optional(),
    checkpoint: ConnectorCheckpointSchema.nullable().optional(),
    lastSyncStatus: NullableConnectorSyncStatusSchema.optional(),
  },
).pick({
  name: true,
  config: true,
  secretId: true,
  schedule: true,
  enabled: true,
  lastSyncAt: true,
  lastSyncStatus: true,
  lastSyncError: true,
  checkpoint: true,
});

export type KnowledgeBaseConnector = z.infer<
  typeof SelectKnowledgeBaseConnectorSchema
>;
export type InsertKnowledgeBaseConnector = z.infer<
  typeof InsertKnowledgeBaseConnectorSchema
>;
export type UpdateKnowledgeBaseConnector = z.infer<
  typeof UpdateKnowledgeBaseConnectorSchema
>;

// ===== Connector Run Schemas =====

export const SelectConnectorRunSchema = createSelectSchema(
  schema.connectorRunsTable,
  { status: ConnectorSyncStatusSchema },
);
export const SelectConnectorRunListSchema = SelectConnectorRunSchema.omit({
  logs: true,
});
export const InsertConnectorRunSchema = createInsertSchema(
  schema.connectorRunsTable,
  { status: ConnectorSyncStatusSchema },
).omit({ id: true, createdAt: true });
export const UpdateConnectorRunSchema = createUpdateSchema(
  schema.connectorRunsTable,
  { status: ConnectorSyncStatusSchema.optional() },
).pick({
  status: true,
  completedAt: true,
  documentsProcessed: true,
  documentsIngested: true,
  totalItems: true,
  error: true,
  logs: true,
  checkpoint: true,
  totalBatches: true,
  completedBatches: true,
});

export type ConnectorRun = z.infer<typeof SelectConnectorRunSchema>;
export type InsertConnectorRun = z.infer<typeof InsertConnectorRunSchema>;
export type UpdateConnectorRun = z.infer<typeof UpdateConnectorRunSchema>;
