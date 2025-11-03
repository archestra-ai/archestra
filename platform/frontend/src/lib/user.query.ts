import type { archestraApiTypes } from "@shared";
import { updateUserOnboarding } from "@shared/hey-api/clients/api/sdk.gen";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useUpdateUserOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateUserOnboardingData["body"];
    }) => {
      const response = await updateUserOnboarding({
        path: { id },
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users-onboarding"] });
    },
  });
}
