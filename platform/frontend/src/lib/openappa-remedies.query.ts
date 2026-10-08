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

export type RemediesActivity =
  archestraApiTypes.GetOpenappaRemediesActivityResponses["200"];
export type BlockedCallsDay = RemediesActivity["days"][number];

/** Denied calls per day over the last week, in the viewer's time zone. */
export function useRemediesActivity() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return useQuery({
    queryKey: ["openappa-remedies-activity", timeZone],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaRemediesActivity(
        { query: { timeZone } },
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}
