"use client";

import { ChatToolsDisplay } from "./chat-tools-display";

export interface McpToolsDisplayProps {
  agentId: string;
  className?: string;
  promptId?: string | null;
}

/**
 * Display MCP tools for an agent profile.
 * This is a wrapper around ChatToolsDisplay for profile-level usage.
 */
export function McpToolsDisplay({
  agentId,
  className,
  promptId,
}: McpToolsDisplayProps) {
  // Use ChatToolsDisplay which handles both conversation and non-conversation (pending actions) states
  return (
    <ChatToolsDisplay
      agentId={agentId}
      className={className}
      promptId={promptId}
    />
  );
}
