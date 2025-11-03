import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation } from "@tanstack/react-query";

const { initiateOAuth } = archestraApiSdk;

export function useInitiateOAuth() {
  return useMutation({
    mutationFn: async (data: archestraApiTypes.InitiateOAuthData["body"]) => {
      const response = await initiateOAuth({ body: data });
      return response.data;
    },
  });
}
