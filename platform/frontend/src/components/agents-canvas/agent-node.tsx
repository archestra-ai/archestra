import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import {
  Bot,
  Link2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { memo, useContext } from "react";
import {
  BaseNode,
  BaseNodeContent,
  BaseNodeHeader,
  BaseNodeHeaderTitle,
} from "@/components/base-node";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentNodeContext } from "./agent-node-context";

export type AgentNodeData = {
  label: string;
  promptId: string;
};

export type AgentNodeType = Node<AgentNodeData, "agent">;

export const AgentNode = memo(({ data }: NodeProps<AgentNodeType>) => {
  const { onEditAgent, onDeleteAgent, onConnectAgent } =
    useContext(AgentNodeContext);

  return (
    <BaseNode className="min-w-[180px]">
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-muted-foreground !w-2 !h-2"
      />
      <BaseNodeHeader>
        <Bot className="size-4 text-muted-foreground" />
        <BaseNodeHeaderTitle>{data.label}</BaseNodeHeaderTitle>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="nodrag h-6 w-6 -mr-1"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEditAgent(data.promptId)}>
              <Pencil className="mr-2 size-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onConnectAgent(data.promptId)}>
              <Link2 className="mr-2 size-4" />
              Connect
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onDeleteAgent(data.promptId)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </BaseNodeHeader>
      <BaseNodeContent className="py-2">
        <Button variant="outline" size="sm" className="nodrag h-7" asChild>
          <Link href={`/chat?promptId=${data.promptId}`}>
            <MessageSquare className="size-3" />
            Chat
          </Link>
        </Button>
      </BaseNodeContent>
      <Handle
        type="source"
        position={Position.Right}
        id="tools"
        className="!bg-primary !w-2 !h-2"
        style={{ top: "50%" }}
      />
    </BaseNode>
  );
});

AgentNode.displayName = "AgentNode";
