"use client";

// Re-export the shared EditConnectorDialog so the knowledge-base app pages
// use a single, canonical implementation (which includes Notion support).
export { EditConnectorDialog } from "@/components/knowledge-base/connectors/EditConnectorDialog";
