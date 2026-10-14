import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

const { getBrowserStorageStates, deleteBrowserStorageState } = archestraApiSdk;

export type SavedBrowserLogin =
  archestraApiTypes.GetBrowserStorageStatesResponses["200"][number];

const savedBrowserLoginsQueryKey = ["browser-storage-states"] as const;

/** Members whose Playwright browser logins are saved. Admins only. */
export function useSavedBrowserLogins(params: { enabled: boolean }) {
  return useQuery({
    queryKey: savedBrowserLoginsQueryKey,
    queryFn: async () => {
      const { data, error } = await getBrowserStorageStates();
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: params.enabled,
  });
}

export function useSignOutBrowserLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const { data, error } = await deleteBrowserStorageState({
        path: { userId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Signed out of the browser");
      queryClient.invalidateQueries({ queryKey: savedBrowserLoginsQueryKey });
    },
  });
}
