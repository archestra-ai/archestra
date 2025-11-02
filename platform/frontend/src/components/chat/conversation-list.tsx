import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Conversation {
  id: string;
  title: string | null;
  selectedModel: string;
  userId: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedConversationId?: string;
  onSelectConversation: (id: string) => void;
  onCreateConversation: () => void;
  onDeleteConversation: (id: string) => void;
  isCreatingConversation?: boolean;
}

export function ConversationList({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onCreateConversation,
  onDeleteConversation,
  isCreatingConversation = false,
}: ConversationListProps) {
  return (
    <div className="w-64 border-r bg-muted/10 flex flex-col h-full">
      <div className="p-4 border-b">
        <Button
          onClick={onCreateConversation}
          disabled={isCreatingConversation}
          className="w-full"
        >
          New Chat
        </Button>
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
                className="flex-1 text-left truncate"
              >
                {conv.title || "New conversation"}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteConversation(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-destructive/10 rounded"
                title="Delete conversation"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
