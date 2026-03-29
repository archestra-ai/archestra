"use client";

// Re-export the shared CreateConnectorDialog so the knowledge-base app pages
// use a single, canonical implementation (which includes Notion support).
export { CreateConnectorDialog } from "@/components/knowledge-base/connectors/CreateConnectorDialog";
