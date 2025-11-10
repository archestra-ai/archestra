import {
  archestraApiClient,
  archestraApiSdk,
  type archestraApiTypes,
} from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";

const { getTools } = archestraApiSdk;

export function useTools({
  initialData,
}: {
  initialData?: archestraApiTypes.GetToolsResponses["200"];
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
  initialData?: archestraApiTypes.GetToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["tools", "unassigned"],
    queryFn: async () => {
      const response = await archestraApiClient.get<
        archestraApiTypes.GetToolsResponses["200"]
      >({
        url: "/api/tools/unassigned",
      });
      return response.data ?? null;
    },
    initialData,
  });
}
