import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { githubCopilotDeviceAuthStart, githubCopilotDeviceAuthPoll } =
  archestraApiSdk;

export type GithubCopilotDeviceStart =
  archestraApiTypes.GithubCopilotDeviceAuthStartResponses["200"];
export type GithubCopilotDevicePoll =
  archestraApiTypes.GithubCopilotDeviceAuthPollResponses["200"];

export function useStartGithubCopilotDeviceFlow() {
  return useMutation({
    mutationFn: async (): Promise<GithubCopilotDeviceStart | null> => {
      const { data, error } = await githubCopilotDeviceAuthStart();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function usePollGithubCopilotDeviceFlow() {
  return useMutation({
    mutationFn: async (
      deviceCode: string,
    ): Promise<GithubCopilotDevicePoll | null> => {
      const { data, error } = await githubCopilotDeviceAuthPoll({
        body: { deviceCode },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}
