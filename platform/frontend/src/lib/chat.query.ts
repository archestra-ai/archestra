import { useSuspenseQuery } from "@tanstack/react-query";
import { type GetChatsResponses, getChats } from "shared/api-client";

export function useChats({
  initialData,
}: {
  initialData?: GetChatsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["chats"],
    queryFn: async () => (await getChats()).data,
    initialData,
  });
}
