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
      // Toast even when the SDK call throws (network down, backend
      // restarting) instead of returning an API error — otherwise the
      // sign-in button fails with no feedback at all.
      try {
        const { data, error } = await githubCopilotDeviceAuthStart();
        if (error) {
          handleApiError(error);
          return null;
        }
        return data;
      } catch (thrown) {
        handleApiError(thrown as Parameters<typeof handleApiError>[0]);
        return null;
      }
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
