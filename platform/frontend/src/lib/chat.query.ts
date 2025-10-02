import { useSuspenseQuery } from "@tanstack/react-query";
import { getChats } from "shared/api-client";

export function useChats() {
  return useSuspenseQuery({
    queryKey: ["chats"],
    queryFn: async () => (await getChats()).data,
  });
}
