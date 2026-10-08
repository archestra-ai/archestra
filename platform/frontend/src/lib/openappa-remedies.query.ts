import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { remediesQueryKey } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils/api";

export type RemediesView =
  archestraApiTypes.GetOpenappaRemediesResponses["200"];
export type Authority = RemediesView["authorities"][number];
export type Sanitizer = RemediesView["sanitizers"][number];
export type Remedy = Authority | Sanitizer;
export type BlockCoverage = RemediesView["blocks"][number];

/** The policy's authorities and sanitizers, and the kinds of block nothing lifts. */
export function useRemedies() {
  return useQuery({
    queryKey: remediesQueryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaRemedies();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}
