import { XIcon } from 'lucide-react';

import { ToolHoverCard } from '@ui/components/ToolHoverCard';
import { Badge } from '@ui/components/ui/badge';
import { formatToolName } from '@ui/lib/utils/tools';
import { useToolsStore } from '@ui/stores';
import type { Tool } from '@ui/types';

import { ToolServerIcon } from '../ToolServerIcon';
import ToolStatusIcon from '../ToolStatusIcon';

interface ToolPillProps {
  tool: Tool;
}

export default function ToolPill({ tool }: ToolPillProps) {
  const { mcpServerName, name, id } = tool;
  const { removeSelectedTool, selectedToolIds } = useToolsStore();

  return (
    <ToolHoverCard
      tool={tool}
      side="top"
      align="start"
      showInstructions={true}
      instructionText="Click the × to remove this tool from your context"
    >
      <Badge variant="secondary" className="flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer">
        <ToolServerIcon toolServerName={mcpServerName} />
        <ToolStatusIcon enabled={selectedToolIds.has(id)} />
        <span>{formatToolName(name)}</span>
        <button
          onClick={() => removeSelectedTool(id)}
          className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5"
          type="button"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </Badge>
    </ToolHoverCard>
  );
}
