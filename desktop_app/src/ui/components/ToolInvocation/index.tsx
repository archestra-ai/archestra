import { ChevronDown, ChevronRight, Clock, Shield, Wrench } from 'lucide-react';
import { useState } from 'react';

import { ScrollArea, ScrollBar } from '@ui/components/ui/scroll-area';
import { cn } from '@ui/lib/utils/tailwind';
import { ToolCallStatus } from '@ui/types';

interface ToolInvocationProps {
  toolName: string;
  args: any;
  result?: any;
  state?: ToolCallStatus;
  startTime?: number;
  endTime?: number;
}

export default function ToolInvocation({
  toolName,
  args,
  result,
  state = ToolCallStatus.Completed,
  startTime,
  endTime,
}: ToolInvocationProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const duration = startTime && endTime ? endTime - startTime : null;

  // Parse result content if it's from MCP
  let displayResult = result;
  if (result?.content && Array.isArray(result.content)) {
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
        state === 'pending' && 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20',
        state === 'awaiting_approval' && 'border-yellow-500 bg-yellow-50/50 dark:bg-yellow-950/20',
        state === 'approved' && 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20',
        state === 'declined' && 'border-gray-500 bg-gray-50/50 dark:bg-gray-950/20',
        state === 'executing' && 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20',
        state === 'completed' && 'border-green-500 bg-green-50/50 dark:bg-green-950/20',
        state === 'error' && 'border-red-500 bg-red-50/50 dark:bg-red-950/20'
      )}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-3 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <div className="flex-shrink-0">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        {state === 'awaiting_approval' ? (
          <Shield className={cn('h-4 w-4 flex-shrink-0', 'text-yellow-600 animate-pulse')} />
        ) : (
          <Wrench
            className={cn(
              'h-4 w-4 flex-shrink-0',
              state === 'pending' && 'text-blue-600 animate-pulse',
              state === 'approved' && 'text-blue-600',
              state === 'declined' && 'text-gray-600',
              state === 'executing' && 'text-blue-600 animate-pulse',
              state === 'completed' && 'text-green-600',
              state === 'error' && 'text-red-600'
            )}
          />
        )}
        <span className="font-medium text-sm flex-1 text-left">{toolName}</span>
        {duration !== null && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{duration}ms</span>
          </div>
        )}
        {state === 'pending' && <span className="text-xs text-blue-600 animate-pulse">Running...</span>}
        {state === 'awaiting_approval' && (
          <span className="text-xs text-yellow-600 animate-pulse">Awaiting approval...</span>
        )}
        {state === 'declined' && <span className="text-xs text-gray-600">Declined</span>}
        {state === 'executing' && <span className="text-xs text-blue-600 animate-pulse">Executing...</span>}
      </button>

      {isExpanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {Object.keys(args).length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Arguments:</div>
              <ScrollArea className="rounded overflow-x-auto">
                <pre className="text-xs bg-black/5 dark:bg-white/5 p-2  rounded">{formatJson(args)}</pre>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>
          )}

          {result && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Result:</div>
              <pre className="text-xs bg-black/5 dark:bg-white/5 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
                {typeof displayResult === 'string' ? displayResult : formatJson(displayResult)}
              </pre>
            </div>
          )}

          {state === 'error' && result && (
            <div className="text-xs text-red-600 dark:text-red-400">Error: {result.message || String(result)}</div>
          )}
        </div>
      )}
    </div>
  );
}
