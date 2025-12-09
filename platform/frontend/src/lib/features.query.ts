import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getFeatures } = archestraApiSdk;

export function useFeatures(params?: {
  initialData?: archestraApiTypes.GetFeaturesResponses["200"];
}) {
  return useQuery({
    queryKey: ["features"],
    queryFn: async () => (await getFeatures()).data ?? null,
    initialData: params?.initialData,
  });
}
