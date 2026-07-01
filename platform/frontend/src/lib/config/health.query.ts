import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const { getHealth } = archestraApiSdk;

type HealthData = archestraApiTypes.GetHealthResponses["200"] | null;

export function useHealth(
  params?: {
    initialData?: archestraApiTypes.GetHealthResponses["200"];
  } & Pick<
    UseQueryOptions<HealthData>,
    "refetchInterval" | "refetchOnReconnect" | "enabled"
  >,
) {
  return useQuery({
    queryKey: ["health"],
    queryFn: async (): Promise<HealthData> => {
      const { data, error } = await getHealth();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    initialData: params?.initialData,
    refetchInterval: params?.refetchInterval,
    refetchOnReconnect: params?.refetchOnReconnect,
    enabled: params?.enabled,
  });
}
