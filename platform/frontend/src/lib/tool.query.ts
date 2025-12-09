import { archestraApiSdk, type archestraApiTypes } from "@shared";
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
