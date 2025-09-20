import { type DynamicToolUIPart } from 'ai';
import { ChevronDown, ChevronRight, Clock, Wrench } from 'lucide-react';
import React, { useState } from 'react';

import { ScrollArea, ScrollBar } from '@ui/components/ui/scroll-area';
import { cn } from '@ui/lib/utils/tailwind';
import { useToolsStore } from '@ui/stores/tools-store';
import { ToolCallStatus } from '@ui/types';

interface ToolInvocationProps {
  tool: DynamicToolUIPart;
}

export default function ToolInvocation({ tool }: ToolInvocationProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const availableTools = useToolsStore((state) => state.availableTools);

  // Extract properties from tool
  const toolName = tool.toolName;
  const args = 'input' in tool ? tool.input : {};
  const result = 'output' in tool ? tool.output : undefined;
  const state =
    tool.state === 'output-available'
      ? ToolCallStatus.Completed
      : tool.state === 'output-error'
        ? ToolCallStatus.Error
        : ToolCallStatus.Pending;

  // Find the tool metadata to get pretty names
  const toolMetadata = availableTools.find((t) => t.id === toolName);
  const mcpServerName = toolMetadata?.mcpServerName;
  const prettyToolName = toolMetadata?.name;

  const startTime = undefined;
  const endTime = undefined;
  const duration = startTime && endTime ? endTime - startTime : null;

  // Parse result content if it's from MCP
  let displayResult = result;
  if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
    // Extract text content from MCP response
    const textContent = result.content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
    displayResult = textContent || result;
  }

  const formatJson = (obj: any) => {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  };

  return (
    <div
      className={cn(
        'border rounded-lg overflow-hidden transition-all',
        state === ToolCallStatus.Pending && 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20',
        state === ToolCallStatus.Completed && 'border-green-500 bg-green-50/50 dark:bg-green-950/20',
        state === ToolCallStatus.Error && 'border-red-500 bg-red-50/50 dark:bg-red-950/20'
      )}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-3 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <div className="flex-shrink-0">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        <Wrench
          className={cn(
            'h-4 w-4 flex-shrink-0',
            state === ToolCallStatus.Pending && 'text-blue-600 animate-pulse',
            state === ToolCallStatus.Completed && 'text-green-600',
            state === ToolCallStatus.Error && 'text-red-600'
          )}
        />
        <span className="font-medium text-sm flex-1 text-left">
          {mcpServerName && prettyToolName ? `${mcpServerName} - ${prettyToolName}` : toolName}
        </span>
        {duration !== null && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{duration}ms</span>
          </div>
        )}
        {state === ToolCallStatus.Pending && <span className="text-xs text-blue-600 animate-pulse">Running...</span>}
      </button>

      {isExpanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {args && typeof args === 'object' && Object.keys(args).length > 0 ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Arguments:</div>
              <ScrollArea className="rounded overflow-x-auto">
                <pre className="text-xs bg-black/5 dark:bg-white/5 p-2  rounded">
                  {args && typeof args === 'object' ? formatJson(args) : String(args)}
                </pre>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>
          ) : null}

          {result ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Result:</div>
              <pre className="text-xs bg-black/5 dark:bg-white/5 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
                {typeof displayResult === 'string'
                  ? displayResult
                  : displayResult !== null && displayResult !== undefined
                    ? formatJson(displayResult)
                    : ''}
              </pre>
            </div>
          ) : null}

          {state === ToolCallStatus.Error && result ? (
            <div className="text-xs text-red-600 dark:text-red-400">
              Error:{' '}
              {typeof result === 'object' && result !== null && 'message' in result
                ? String((result as any).message)
                : String(result)}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
