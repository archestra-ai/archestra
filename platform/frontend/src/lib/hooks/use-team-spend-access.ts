import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

/** Team leadership discovery does not require organization directory access. */
export function useTeamSpendAccess() {
  const session = useSession();
  const query = useQuery({
    queryKey: [
      "team-spend-access",
      session?.data?.user.id,
      session?.data?.session.activeOrganizationId,
    ],
    enabled: !!session?.data?.user,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getTeamSpendAccess();
      throwOnApiError(error, { toastOnError: false });
      return data?.administeredTeamIds ?? [];
    },
  });
  return {
    administeredTeamIds: query.data ?? [],
    isTeamAdmin: !!query.data?.length,
    isPending: query.isPending,
  };
}
