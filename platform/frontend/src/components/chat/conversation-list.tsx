import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { AgentSelector } from "./agent-selector";

interface Conversation {
  id: string;
  title: string | null;
  selectedModel: string;
  userId: string;
  organizationId: string;
  agentId: string;
  agent: {
    id: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedConversationId?: string;
  onSelectConversation: (id: string) => void;
  onSelectAgent: (agentId: string) => void;
  onDeleteConversation: (id: string) => void;
  isCreatingConversation?: boolean;
  hideToolCalls: boolean;
  onToggleHideToolCalls: (hide: boolean) => void;
}

export function ConversationList({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onSelectAgent,
  onDeleteConversation,
  isCreatingConversation = false,
  hideToolCalls,
  onToggleHideToolCalls,
}: ConversationListProps) {
  return (
    <div className="w-64 border-r bg-muted/10 flex flex-col h-full">
      <div className="p-4 border-b">
        <AgentSelector
          onSelectAgent={onSelectAgent}
          disabled={isCreatingConversation}
        />
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group relative flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors ${
                selectedConversationId === conv.id ? "bg-accent" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectConversation(conv.id)}
                className="flex-1 text-left min-w-0"
              >
                <div className="truncate">
                  {conv.title || "New conversation"}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <Badge variant="outline" className="text-xs py-0 px-1">
                    {conv.agent.name}
                  </Badge>
                </div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteConversation(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-destructive/10 rounded shrink-0"
                title="Delete conversation"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="p-4 border-t">
        <div className="flex items-center justify-between">
          <Label htmlFor="hide-tool-calls" className="text-sm cursor-pointer">
            Hide tool calls
          </Label>
          <Switch
            id="hide-tool-calls"
            checked={hideToolCalls}
            onCheckedChange={onToggleHideToolCalls}
          />
        </div>
      </div>
    </div>
  );
}
