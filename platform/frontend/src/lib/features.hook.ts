import type { GetFeaturesResponses } from "@/lib/clients/api";
import { useFeatures } from "./features.query";

export function useFeatureFlag(
  flag: keyof GetFeaturesResponses["200"],
): boolean {
  const { data: features, isLoading } = useFeatures();

  // Return false while loading or if data is not available
  if (isLoading || !features) {
    return false;
  }

  return features[flag] ?? false;
}
