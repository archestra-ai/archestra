import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { DeleteChatConfirmation } from '@ui/components/DeleteChatConfirmation';
import { EditableTitle } from '@ui/components/EditableTitle';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@ui/components/ui/sidebar';
import config from '@ui/config';
import { useChatStore } from '@ui/stores';

interface ChatSidebarProps {}

export default function ChatSidebarSection(_props: ChatSidebarProps) {
  const { chats, getCurrentChat, isLoadingChats, selectChat, deleteCurrentChat, updateChatTitle } = useChatStore();
  const currentChatId = getCurrentChat()?.id;
  const [showAllChats, setShowAllChats] = useState(false);

  const VISIBLE_CHAT_COUNT = 5;
  const visibleChats = showAllChats ? chats : chats.slice(0, VISIBLE_CHAT_COUNT);
  const hiddenChatsCount = Math.max(0, chats.length - VISIBLE_CHAT_COUNT);

  return (
    <SidebarMenuSub>
      {isLoadingChats ? (
        <SidebarMenuSubItem>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
            <span className="text-xs text-muted-foreground">Loading agents...</span>
          </div>
        </SidebarMenuSubItem>
      ) : chats.length === 0 ? (
        <SidebarMenuSubItem>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No agents yet</div>
        </SidebarMenuSubItem>
      ) : (
        <>
          {visibleChats.map((chat) => {
            const { id, title } = chat;
            const isCurrentChat = currentChatId === id;

            return (
              <SidebarMenuSubItem key={id} className="group/chat-item">
                <div className="flex items-center w-full">
                  <SidebarMenuSubButton
                    onClick={() => selectChat(id)}
                    isActive={isCurrentChat}
                    className="cursor-pointer hover:bg-accent/50 flex-1 pr-1"
                  >
                    <EditableTitle
                      className="truncate"
                      title={title || config.chat.defaultTitle}
                      onSave={(newTitle) => updateChatTitle(id, newTitle)}
                      isAnimated
                    />
                  </SidebarMenuSubButton>
                  <DeleteChatConfirmation onDelete={deleteCurrentChat} />
                </div>
              </SidebarMenuSubItem>
            );
          })}
          {hiddenChatsCount > 0 && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                onClick={() => setShowAllChats(!showAllChats)}
                className="cursor-pointer hover:bg-accent/50 text-xs text-muted-foreground"
              >
                {showAllChats ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>{showAllChats ? 'Show less' : `Show ${hiddenChatsCount} more`}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </>
      )}
    </SidebarMenuSub>
  );
}
