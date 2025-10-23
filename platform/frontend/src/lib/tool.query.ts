import { useSuspenseQuery } from "@tanstack/react-query";
import { type GetToolsResponses, getTools } from "@/lib/clients/api";
import { client } from "@/lib/clients/api/client.gen";

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

export function useUnassignedTools({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools", "unassigned"],
    queryFn: async () => {
      const response = await client.get<GetToolsResponses["200"]>({
        url: "/api/tools/unassigned",
      });
      return response.data ?? null;
    },
    initialData,
  });
}
