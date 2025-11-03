import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getTeams } = archestraApiSdk;

export function useTeams(params?: {
  initialData?: archestraApiTypes.GetTeamsResponses["200"];
}) {
  return useQuery({
    queryKey: ["teams"],
    queryFn: async () => (await getTeams()).data ?? [],
    initialData: params?.initialData,
  });
}
