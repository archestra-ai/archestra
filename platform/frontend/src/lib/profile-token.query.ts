import { archestraApiSdk } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const { getProfileTokens, rotateProfileToken } = archestraApiSdk;

export function useProfileTokens(profileId: string | undefined) {
  return useQuery({
    queryKey: ["profileTokens", profileId],
    queryFn: async () => {
      if (!profileId) return [];
      const response = await getProfileTokens({ path: { profileId } });
      return response.data ?? [];
    },
    enabled: !!profileId,
  });
}

export function useRotateProfileToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profileId,
      tokenId,
    }: {
      profileId: string;
      tokenId: string;
    }) => {
      const response = await rotateProfileToken({
        path: { profileId, tokenId },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["profileTokens", variables.profileId],
      });
    },
    onError: () => {
      toast.error("Failed to rotate token");
    },
  });
}
