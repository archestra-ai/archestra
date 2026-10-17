import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

/**
 * Whether the default admin credentials are still active, fetched only when
 * `enabled`: the app shell asks it of the one viewer its warning is for. Shares
 * the cache entry of `useDefaultCredentialsEnabled`.
 */
export function useDefaultCredentialsStatus({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: authQueryKeys.defaultCredentialsEnabled(),
    enabled,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getDefaultCredentialsStatus();
      throwOnApiError(error, { toastOnError: false });
      return data?.enabled ?? false;
    },
  });
}
