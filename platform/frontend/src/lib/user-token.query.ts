import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError } from "./utils";

const { getUserToken, getUserTokenValue, rotateUserToken } = archestraApiSdk;

/**
 * Personal user token type from the API
 */
export interface UserToken {
  id: string;
  name: string;
  tokenStart: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Hook to fetch current user's personal token
 * Creates token if it doesn't exist
 */
export function useUserToken() {
  return useQuery({
    queryKey: ["userToken"],
    queryFn: async () => {
      const { data, error } = await getUserToken();
      throwOnApiError(error);
      return data as UserToken;
    },
    retry: false,
  });
}

/**
 * Hook to fetch the full personal token value
 */
export function useUserTokenValue() {
  return useQuery({
    queryKey: ["userTokenValue"],
    queryFn: async () => {
      const response = await getUserTokenValue();
      throwOnApiError(response.error);
      return response.data as { value: string };
    },
    enabled: false, // Only fetch on demand
  });
}

/**
 * Mutation hook to fetch personal token value on demand
 * Use this in components that need to fetch the token on button click
 */
export function useFetchUserTokenValue() {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await getUserTokenValue();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as { value: string };
    },
  });
}

/**
 * Hook to rotate personal token
 */
export function useRotateUserToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await rotateUserToken();
      if (response.error) {
        handleApiError(response.error);
      }
      return response.data as UserToken & { value: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userToken"] });
      queryClient.invalidateQueries({ queryKey: ["userTokenValue"] });
    },
  });
}
