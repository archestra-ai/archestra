import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { throwOnApiError } from "./utils";

const { getAllUserCredentials, upsertUserCredential, deleteUserCredential } =
  archestraApiSdk;

export const userCredentialsKeys = {
  all: ["user-credentials"] as const,
};

/**
 * The credentials the signed-in person has supplied. Values never come back —
 * only which keys exist and when they were last set.
 */
export function useUserCredentials() {
  return useQuery({
    queryKey: userCredentialsKeys.all,
    queryFn: async () => {
      const { data, error } = await getAllUserCredentials();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useUpsertUserCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { data, error } = await upsertUserCredential({
        path: { key },
        body: { value },
      });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userCredentialsKeys.all });
    },
  });
}

export function useDeleteUserCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const { data, error } = await deleteUserCredential({ path: { key } });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userCredentialsKeys.all });
    },
  });
}
