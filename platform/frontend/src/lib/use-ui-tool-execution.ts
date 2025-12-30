import { useCallback } from "react";
import { toast } from "sonner";

interface UseUIToolExecutionOptions {
  agentId: string;
  onToolResult?: (toolName: string, result: unknown) => void;
}

export function useUIToolExecution({
  agentId,
  onToolResult,
}: UseUIToolExecutionOptions) {
  const executeToolCall = useCallback(
    async (toolName: string, params: Record<string, unknown>) => {
      try {
        const response = await fetch(`/api/v1/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${agentId}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: toolName, arguments: params },
            id: crypto.randomUUID(),
          }),
        });

        if (!response.ok) {
          throw new Error(`Tool call failed: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.error) {
          throw new Error(result.error.message || "Tool execution failed");
        }

        onToolResult?.(toolName, result.result);
        return result.result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Tool call failed: ${message}`);
        throw error;
      }
    },
    [agentId, onToolResult],
  );

  return { executeToolCall };
}
