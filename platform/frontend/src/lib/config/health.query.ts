import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

const { getHealth, getReady } = archestraApiSdk;

type HealthData = archestraApiTypes.GetHealthResponses["200"] | null;
type ReadinessData =
  | archestraApiTypes.GetReadyResponses["200"]
  | archestraApiTypes.GetReadyErrors[503];

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

export function useReadiness(
  params?: Pick<
    UseQueryOptions<ReadinessData>,
    "refetchInterval" | "refetchOnReconnect" | "enabled"
  >,
) {
  return useQuery({
    queryKey: ["readiness"],
    queryFn: async (): Promise<ReadinessData> => {
      const { data, error } = await getReady();
      if (error?.database === "disconnected") {
        return error;
      }
      throwOnApiError(error, { toastOnError: false });
      if (!data) {
        throw new Error("Readiness response was empty");
      }
      return data;
    },
    refetchInterval: params?.refetchInterval,
    refetchOnReconnect: params?.refetchOnReconnect,
    enabled: params?.enabled,
  });
}
