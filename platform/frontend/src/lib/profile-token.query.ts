import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const {
  getProfileTokens,
  createProfileToken,
  deleteProfileToken,
  updateProfileToken,
  rotateProfileToken,
} = archestraApiSdk;

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

export function useCreateProfileToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profileId,
      data,
    }: {
      profileId: string;
      data: archestraApiTypes.CreateProfileTokenData["body"];
    }) => {
      const response = await createProfileToken({
        path: { profileId },
        body: data,
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["profileTokens", variables.profileId],
      });
    },
  });
}

export function useUpdateProfileToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profileId,
      tokenId,
      data,
    }: {
      profileId: string;
      tokenId: string;
      data: archestraApiTypes.UpdateProfileTokenData["body"];
    }) => {
      const response = await updateProfileToken({
        path: { profileId, tokenId },
        body: data,
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["profileTokens", variables.profileId],
      });
    },
  });
}

export function useDeleteProfileToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profileId,
      tokenId,
    }: {
      profileId: string;
      tokenId: string;
    }) => {
      const response = await deleteProfileToken({
        path: { profileId, tokenId },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["profileTokens", variables.profileId],
      });
    },
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
  });
}
