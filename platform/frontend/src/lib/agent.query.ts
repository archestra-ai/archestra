import { type GetAgentsResponses, getAgents } from "@shared/api-client";
import { useSuspenseQuery } from "@tanstack/react-query";

export function useAgents(params?: {
  initialData?: GetAgentsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["agents"],
    queryFn: async () => (await getAgents()).data ?? null,
    initialData: params?.initialData,
  });
}
