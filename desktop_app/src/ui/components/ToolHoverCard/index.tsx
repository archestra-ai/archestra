import React from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@ui/components/ui/hover-card';
import { cn } from '@ui/lib/utils/tailwind';
import { formatToolName } from '@ui/lib/utils/tools';
import { useToolsStore } from '@ui/stores';
import type { Tool } from '@ui/types';

import { ToolServerIcon } from '../ToolServerIcon';
import ToolStatusIcon from '../ToolStatusIcon';

interface ToolHoverCardProps extends React.PropsWithChildren {
  tool: Tool;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  showInstructions?: boolean;
  instructionText?: string;
}

export function ToolHoverCard({
  tool,
  children,
  side = 'right',
  align = 'start',
  showInstructions = false,
  instructionText,
}: ToolHoverCardProps) {
  const { selectedToolIds } = useToolsStore();
  const isSelected = selectedToolIds.has(tool.id);

  const {
    mcpServerName,
    name,
    description,
    analysis: { is_read, is_write, idempotent, reversible, status, error },
  } = tool;

  return (
    <HoverCard openDelay={100} closeDelay={0}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent className="w-80" side={side} align={align}>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <ToolServerIcon toolServerName={mcpServerName} />
            <div>
              <h4 className="font-semibold">{formatToolName(name)}</h4>
              <p className="text-xs text-muted-foreground">From {mcpServerName}</p>
            </div>
          </div>

          {description && (
            <div>
              <p className="text-sm text-muted-foreground line-clamp-10">{description}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t">
            <ToolStatusIcon enabled={isSelected} />
            <span className="text-xs text-muted-foreground">{!isSelected ? 'Disabled' : 'Available'}</span>
          </div>

          {/* Tool Analysis Results */}
          <div className="pt-2 border-t space-y-1">
            <h5 className="text-xs font-semibold text-muted-foreground mb-1">Tool Properties</h5>

            {/* Analysis Status Message */}
            {status !== 'completed' && (
              <div className="mb-2">
                {status === 'awaiting_ollama_model' && (
                  <p className="text-xs text-muted-foreground">Waiting for Ollama model to be available...</p>
                )}
                {status === 'in_progress' && (
                  <p className="text-xs text-muted-foreground">Analyzing tool properties...</p>
                )}
                {status === 'error' && (
                  <p className="text-xs text-red-600">Failed to analyze: {error || 'Unknown error'}</p>
                )}
              </div>
            )}

            {/* Show properties only if analysis is completed */}
            {status === 'completed' &&
              (is_read !== null || is_write !== null || idempotent !== null || reversible !== null) && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {is_read !== null && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Read-only:</span>
                      <span className={cn('text-xs font-medium', is_read ? 'text-green-600' : 'text-orange-600')}>
                        {is_read ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                  {is_write !== null && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Writes data:</span>
                      <span className={cn('text-xs font-medium', is_write ? 'text-orange-600' : 'text-green-600')}>
                        {is_write ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                  {idempotent !== null && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Idempotent:</span>
                      <span className={cn('text-xs font-medium', idempotent ? 'text-green-600' : 'text-orange-600')}>
                        {idempotent ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                  {reversible !== null && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Reversible:</span>
                      <span className={cn('text-xs font-medium', reversible ? 'text-green-600' : 'text-orange-600')}>
                        {reversible ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                </div>
              )}
          </div>

          {showInstructions && instructionText && (
            <div className="text-xs text-muted-foreground pt-2 border-t">{instructionText}</div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
