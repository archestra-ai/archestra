import {
  type GetChatResponses,
  type GetChatsResponses,
  getChat,
  getChats,
} from "@shared/api-client";
import { useSuspenseQuery } from "@tanstack/react-query";

export function useChats({
  initialData,
}: {
  initialData?: GetChatsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["chats"],
    queryFn: async () => (await getChats()).data ?? null,
    initialData,
    refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
  });
}

export function useChat({
  initialData,
  id,
}: {
  initialData?: GetChatResponses["200"];
  id: string;
}) {
  return useSuspenseQuery({
    queryKey: ["chat", id],
    queryFn: async () => (await getChat({ path: { chatId: id } })).data ?? null,
    initialData,
    refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
  });
}
