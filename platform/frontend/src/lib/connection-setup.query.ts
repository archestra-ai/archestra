import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { createConnectionSetup } = archestraApiSdk;

export type CreateConnectionSetupBody =
  archestraApiTypes.CreateConnectionSetupData["body"];
export type CreateConnectionSetupResult =
  archestraApiTypes.CreateConnectionSetupResponses["200"];

export function useCreateConnectionSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateConnectionSetupBody) => {
      const { data, error } = await createConnectionSetup({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      // the setup may have provisioned a personal virtual key and, on script
      // fetch, will create a skill share link — keep those lists fresh.
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["skill-share-links"] });
    },
  });
}
