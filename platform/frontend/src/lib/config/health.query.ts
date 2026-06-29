import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const { getHealth } = archestraApiSdk;

export function useHealth(params?: {
  initialData?: archestraApiTypes.GetHealthResponses["200"];
}) {
  return useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const { data, error } = await getHealth();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    initialData: params?.initialData,
  });
}
