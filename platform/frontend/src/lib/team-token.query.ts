import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "./utils";

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
 * Token permissions from the API
 */
export interface TokenPermissions {
  canAccessOrgToken: boolean;
  canAccessTeamTokens: boolean;
}

/**
 * Response type from GET /api/tokens
 */
export interface TokensListResponse {
  tokens: TeamToken[];
  permissions: TokenPermissions;
}

/**
 * Hook to fetch tokens for the organization
 * Returns both tokens and permission flags
 *
 * When profileId is provided, team tokens are filtered to only include
 * tokens for teams that the profile is also assigned to.
 */
export function useTokens(params?: { profileId?: string }) {
  const { profileId } = params ?? {};
  return useQuery({
    queryKey: ["tokens", { profileId }],
    queryFn: async () => {
      const response = await getTokens({ query: { profileId } });
      if (response.error) {
        handleApiError(response.error);
      }
      const data = response.data as TokensListResponse | undefined;
      return {
        tokens: data?.tokens ?? [],
        permissions: data?.permissions ?? {
          canAccessOrgToken: false,
          canAccessTeamTokens: false,
        },
      };
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
 * Mutation hook to fetch team token value on demand
 * Use this in components that need to fetch the token on button click
 */
export function useFetchTeamTokenValue() {
  return useMutation({
    mutationFn: async (tokenId: string) => {
      const { data, error } = await getTokenValue({ path: { tokenId } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as { value: string };
    },
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
      if (response.error) {
        handleApiError(response.error);
      }
      return response.data as { value: string };
    },
    onSuccess: (_data, tokenId) => {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      queryClient.invalidateQueries({ queryKey: ["tokenValue", tokenId] });
    },
  });
}
