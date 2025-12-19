import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
      const response = await getUserToken();
      if (!response.data) {
        throw new Error("Failed to fetch personal token");
      }
      return response.data as UserToken;
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
      return response.data as { value: string };
    },
    enabled: false, // Only fetch on demand
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
      return response.data as UserToken & { value: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userToken"] });
      queryClient.invalidateQueries({ queryKey: ["userTokenValue"] });
    },
    onError: () => {
      toast.error("Failed to rotate personal token");
    },
  });
}
