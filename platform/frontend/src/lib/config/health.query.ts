import * as archestraApiSdk from "@shared/api/sdk";
import type * as archestraApiTypes from "@shared/api/types";
import { useQuery } from "@tanstack/react-query";

const { getHealth } = archestraApiSdk;

export function useHealth(params?: {
  initialData?: archestraApiTypes.GetHealthResponses["200"];
}) {
  return useQuery({
    queryKey: ["health"],
    queryFn: async () => (await getHealth()).data ?? null,
    initialData: params?.initialData,
  });
}
