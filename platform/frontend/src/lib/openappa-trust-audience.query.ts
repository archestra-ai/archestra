import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { trustAudienceQueryKey } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils/api";

export type TrustAudienceView =
  archestraApiTypes.GetOpenappaTrustAudienceResponses["200"];
export type AudienceLevel = TrustAudienceView["audiences"][number];

/** The policy's trust levels and audiences, with the audience sources each one reads. */
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
