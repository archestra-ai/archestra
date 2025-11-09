import { Edit2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
  onUpdateConversation: (id: string, title: string) => void;
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
  onUpdateConversation,
  onDeleteConversation,
  isCreatingConversation = false,
  hideToolCalls,
  onToggleHideToolCalls,
}: ConversationListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handleStartEdit = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditingTitle(conv.title || "");
  };

  const handleSaveEdit = (id: string) => {
    if (editingTitle.trim()) {
      onUpdateConversation(id, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

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
              className={`group relative flex items-center gap-1 px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors ${
                selectedConversationId === conv.id ? "bg-accent" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectConversation(conv.id)}
                className="flex-1 min-w-0 text-left overflow-hidden"
              >
                {editingId === conv.id ? (
                  <Input
                    ref={inputRef}
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => handleSaveEdit(conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleSaveEdit(conv.id);
                      } else if (e.key === "Escape") {
                        handleCancelEdit();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 text-sm"
                  />
                ) : (
                  <div
                    className="truncate max-w-[140px]"
                    title={conv.title || "New conversation"}
                  >
                    {conv.title || "New conversation"}
                  </div>
                )}
                <div className="flex items-center gap-1 mt-0.5 w-full">
                  <Badge
                    variant="outline"
                    className="text-xs py-0 px-1 truncate max-w-full"
                  >
                    {conv.agent.name}
                  </Badge>
                </div>
              </button>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {editingId !== conv.id && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(conv);
                    }}
                    className="p-1 hover:bg-muted rounded shrink-0"
                    title="Edit conversation name"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(conv.id);
                  }}
                  className="p-1 hover:bg-destructive/10 rounded shrink-0"
                  title="Delete conversation"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </button>
              </div>
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
