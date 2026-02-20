import type { FeaturesResponse } from "./config.query";
import { useFeatures } from "./config.query";

export function useFeatureFlag(flag: keyof FeaturesResponse): boolean {
  const { data: features, isLoading } = useFeatures();

  // Return false while loading or if data is not available
  if (isLoading || !features) {
    return false;
  }

  return (features[flag] as boolean) ?? false;
}

export function useFeatureValue<K extends keyof FeaturesResponse>(
  flag: K,
): FeaturesResponse[K] | null {
  const { data: features, isLoading } = useFeatures();

  // Return null while loading or if data is not available
  if (isLoading || !features) {
    return null;
  }

  return features[flag];
}
