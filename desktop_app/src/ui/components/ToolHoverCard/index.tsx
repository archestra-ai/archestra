import React from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@ui/components/ui/hover-card';
import { cn } from '@ui/lib/utils/tailwind';
import { formatToolName } from '@ui/lib/utils/tools';
import type { Tool } from '@ui/types';

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
  const {
    mcpServerName,
    name,
    description,
    analysis: { is_read, is_write },
  } = tool;

  return (
    <HoverCard openDelay={100} closeDelay={0}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent className="w-80" side={side} align={align}>
        <div className="space-y-2">
          <div>
            <h4 className="font-semibold text-sm">{formatToolName(name)}</h4>
            <p className="text-xs text-muted-foreground">From {mcpServerName}</p>
          </div>

          {description && <p className="text-xs text-muted-foreground">{description}</p>}

          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Access:</span>
            <span
              className={cn(
                'font-medium',
                is_read && is_write
                  ? 'text-blue-600'
                  : is_read
                    ? 'text-green-600'
                    : is_write
                      ? 'text-orange-600'
                      : 'text-gray-600'
              )}
            >
              {is_read && is_write ? 'Read/Write' : is_read ? 'Read' : is_write ? 'Write' : 'None'}
            </span>
          </div>

          {showInstructions && instructionText && (
            <div className="text-xs text-muted-foreground italic">{instructionText}</div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
