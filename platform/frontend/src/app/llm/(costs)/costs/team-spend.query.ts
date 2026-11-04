import { archestraApiSdk, type StatisticsTimeFrame } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

export function useTeamSpend(
  timeframe: StatisticsTimeFrame,
  enabled: boolean,
  includePeople = false,
) {
  return useQuery({
    queryKey: ["team-spend", timeframe, includePeople],
    enabled,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getTeamSpend({
        query: {
          timeframe,
          ...(includePeople ? { includePeople: "true" as const } : {}),
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}
