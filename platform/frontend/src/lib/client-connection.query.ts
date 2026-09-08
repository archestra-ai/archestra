import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

export function useClientConnection(id: string) {
  return useQuery({
    queryKey: ["client-connection", id],
    enabled: Boolean(id),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.error ? false : 10_000),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getClientConnection({
        path: { id },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useDecideClientConnection(id: string) {
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.DecideClientConnectionData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.decideClientConnection({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
  });
}
