import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation } from "@tanstack/react-query";

const { initiateOAuth } = archestraApiSdk;

export function useInitiateOAuth() {
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.InitiateOAuthData["body"],
    ): Promise<archestraApiTypes.InitiateOAuthResponses["200"]> => {
      const response = await initiateOAuth({ body: data });
      if (response.error || !response.data) {
        const msg =
          response.error && typeof response.error.error === "string"
            ? response.error.error
            : response.error?.error?.message || "Failed to initiate OAuth flow";
        throw new Error(msg);
      }
      return response.data;
    },
  });
}
