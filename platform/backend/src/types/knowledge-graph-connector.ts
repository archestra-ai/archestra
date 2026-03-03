import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

// ===== Knowledge Graph Schemas =====

export const SelectKnowledgeGraphSchema = createSelectSchema(
  schema.knowledgeGraphsTable,
);
export const InsertKnowledgeGraphSchema = createInsertSchema(
  schema.knowledgeGraphsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKnowledgeGraphSchema = createUpdateSchema(
  schema.knowledgeGraphsTable,
).pick({ name: true, config: true, secretId: true, status: true });

export type KnowledgeGraph = z.infer<typeof SelectKnowledgeGraphSchema>;
export type InsertKnowledgeGraph = z.infer<typeof InsertKnowledgeGraphSchema>;
export type UpdateKnowledgeGraph = z.infer<typeof UpdateKnowledgeGraphSchema>;

// ===== Knowledge Graph Connector Schemas =====

export const SelectKnowledgeGraphConnectorSchema = createSelectSchema(
  schema.knowledgeGraphConnectorsTable,
);
export const InsertKnowledgeGraphConnectorSchema = createInsertSchema(
  schema.knowledgeGraphConnectorsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKnowledgeGraphConnectorSchema = createUpdateSchema(
  schema.knowledgeGraphConnectorsTable,
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

export type KnowledgeGraphConnector = z.infer<
  typeof SelectKnowledgeGraphConnectorSchema
>;
export type InsertKnowledgeGraphConnector = z.infer<
  typeof InsertKnowledgeGraphConnectorSchema
>;
export type UpdateKnowledgeGraphConnector = z.infer<
  typeof UpdateKnowledgeGraphConnectorSchema
>;

// ===== Connector Run Schemas =====

export const SelectConnectorRunSchema = createSelectSchema(
  schema.connectorRunsTable,
);
export const InsertConnectorRunSchema = createInsertSchema(
  schema.connectorRunsTable,
).omit({ id: true, createdAt: true });
export const UpdateConnectorRunSchema = createUpdateSchema(
  schema.connectorRunsTable,
).pick({
  status: true,
  completedAt: true,
  documentsProcessed: true,
  documentsIngested: true,
  error: true,
  checkpoint: true,
});

export type ConnectorRun = z.infer<typeof SelectConnectorRunSchema>;
export type InsertConnectorRun = z.infer<typeof InsertConnectorRunSchema>;
export type UpdateConnectorRun = z.infer<typeof UpdateConnectorRunSchema>;
