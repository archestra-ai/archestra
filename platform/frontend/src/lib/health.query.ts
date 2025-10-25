import { useQuery } from "@tanstack/react-query";
import { type GetHealthResponses, getHealth } from "@/lib/clients/api";

export function useHealth(params?: {
  initialData?: GetHealthResponses["200"];
}) {
  return useQuery({
    queryKey: ["health"],
    queryFn: async () => (await getHealth()).data ?? null,
    initialData: params?.initialData,
  });
}
