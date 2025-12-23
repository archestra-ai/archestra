/**
 * Definición de tipos para la integración de MCP-UI
 
 */

export interface McpUiMetadata {
  componentName: string;
  props: Record<string, any>;
  viewType?: 'card' | 'full' | 'inline';
}

export interface McpToolResultWithUi {
  content: any;
  ui?: McpUiMetadata;
  isError?: boolean;
}
