import { archestraApiSdk } from "@archestra/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { guardrailsPolicyQueryKey } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils/api";

export function useGuardrailsPolicy() {
  const { data: canRead } = useHasPermissions({ guardrailsPolicy: ["read"] });
  return useQuery({
    ...guardrailsPolicyQuery,
    enabled: canRead === true,
    refetchInterval: 10000,
  });
}

/** The organization policy's root text, for a caller that fetches it on demand. */
export const guardrailsPolicyQuery = queryOptions({
  queryKey: guardrailsPolicyQueryKey,
  queryFn: async () => {
    const { data, error } = await archestraApiSdk.getGuardrailsPolicy();
    throwOnApiError(error, { toastOnError: false });
    return data ?? null;
  },
});
