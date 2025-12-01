import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getTeams } = archestraApiSdk;

type Teams = archestraApiTypes.GetTeamsResponses["200"];
export type Team = Teams[number];

export function useTeams(params?: { initialData?: Teams }) {
  return useQuery({
    queryKey: ["teams"],
    queryFn: async () => (await getTeams()).data ?? [],
    initialData: params?.initialData,
  });
}
