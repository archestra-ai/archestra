import { Conversation as RootConversation } from "./conversation";
import { ConversationContent } from "./conversation-content";
import { ConversationEmptyState } from "./conversation-empty-state";
import { ConversationScrollButton } from "./conversation-scroll-button";

export const Conversation = Object.assign(RootConversation, {
  Content: ConversationContent,
  EmptyState: ConversationEmptyState,
  ScrollButton: ConversationScrollButton,
});
