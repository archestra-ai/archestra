import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { guardrailsPolicyQueryKey } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils/api";

export function useGuardrailsPolicy() {
  const { data: canRead } = useHasPermissions({ openappaPolicy: ["read"] });
  return useQuery({
    enabled: canRead === true,
    queryKey: guardrailsPolicyQueryKey,
    refetchInterval: 10000,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getGuardrailsPolicy();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}
