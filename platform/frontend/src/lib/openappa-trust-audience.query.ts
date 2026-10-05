import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { trustAudienceQueryKey } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils/api";

export type TrustAudienceView =
  archestraApiTypes.GetOpenappaTrustAudienceResponses["200"];
export type AudienceLevel = TrustAudienceView["audiences"][number];
export type AudienceSource = TrustAudienceView["sources"][number];

/** The policy's trust levels, audiences, and the audience sources batteries declare. */
export function useTrustAudience() {
  return useQuery({
    queryKey: trustAudienceQueryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaTrustAudience();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}
