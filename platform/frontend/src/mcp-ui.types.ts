/**
 * platform/frontend/src/mcp-ui.types.ts
 * Re-exportación y definición de tipos MCP-UI para el Frontend
 */
import { z } from "zod";


import { 
  McpUiMetadataSchema, 
  McpToolResponseSchema 
} from "../../shared/zod-schemas";


import type { 
  McpUiMetadata as McpUiMetadataBase, 
  McpToolResultWithUi 
} from "../../shared/mcp-ui.types";


export type McpUiMetadata = z.infer<typeof McpUiMetadataSchema>;
export type McpToolResponse = z.infer<typeof McpToolResponseSchema>;


export type { McpToolResultWithUi };


export interface McpComponentProps {
  data: any;
  metadata?: McpUiMetadata;
}