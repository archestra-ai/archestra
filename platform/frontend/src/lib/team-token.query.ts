import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const { getTokens, getTokenValue, rotateToken } = archestraApiSdk;

/**
 * Team token type from the API
 */
export interface TeamToken {
  id: string;
  organizationId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  name: string;
  tokenStart: string;
  createdAt: string;
  lastUsedAt: string | null;
  team: {
    id: string;
    name: string;
  } | null;
}

/**
 * Hook to fetch all tokens for the organization
 */
export function useTokens() {
  return useQuery({
    queryKey: ["tokens"],
    queryFn: async () => {
      const response = await getTokens();
      return (response.data ?? []) as TeamToken[];
    },
  });
}

/**
 * Hook to fetch the full token value
 */
export function useTokenValue(tokenId: string | undefined) {
  return useQuery({
    queryKey: ["tokenValue", tokenId],
    queryFn: async () => {
      if (!tokenId) return null;
      const response = await getTokenValue({ path: { tokenId } });
      return response.data as { value: string };
    },
    enabled: false, // Only fetch on demand
  });
}

/**
 * Hook to rotate a token
 */
export function useRotateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tokenId: string) => {
      const response = await rotateToken({ path: { tokenId } });
      return response.data as { value: string };
    },
    onSuccess: (_data, tokenId) => {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      queryClient.invalidateQueries({ queryKey: ["tokenValue", tokenId] });
    },
    onError: () => {
      toast.error("Failed to rotate token");
    },
  });
}
