import { useSuspenseQuery } from "@tanstack/react-query";
import { type GetToolsResponses, getTools } from "@/lib/clients/api";

export function useTools({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools"],
    queryFn: async () => (await getTools()).data ?? null,
    initialData,
  });
}
