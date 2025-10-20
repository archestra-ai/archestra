import { useSuspenseQuery } from "@tanstack/react-query";
import { type GetFeaturesResponses, getFeatures } from "@/lib/clients/api";

export function useFeatures(params?: {
  initialData?: GetFeaturesResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["features"],
    queryFn: async () => (await getFeatures()).data ?? null,
    initialData: params?.initialData,
  });
}
