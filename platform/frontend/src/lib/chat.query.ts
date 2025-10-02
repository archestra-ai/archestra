import { useQuery } from "@tanstack/react-query";
import { getChats } from "shared/api-client";

export function useChats() {
  return useQuery({
    queryKey: ["chats"],
    queryFn: async () => (await getChats()).data,
  });
}
