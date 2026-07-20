import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { openaiCodexDeviceAuthStart, openaiCodexDeviceAuthPoll } =
  archestraApiSdk;

export type OpenaiCodexDeviceStart =
  archestraApiTypes.OpenaiCodexDeviceAuthStartResponses["200"];
export type OpenaiCodexDevicePoll =
  archestraApiTypes.OpenaiCodexDeviceAuthPollResponses["200"];

export function useStartOpenaiCodexDeviceFlow() {
  return useMutation({
    mutationFn: async (): Promise<OpenaiCodexDeviceStart | null> => {
      // Toast even when the SDK call throws (network down, backend restarting)
      // instead of returning an API error — otherwise the sign-in button fails
      // with no feedback at all.
      try {
        const { data, error } = await openaiCodexDeviceAuthStart();
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

export function usePollOpenaiCodexDeviceFlow() {
  return useMutation({
    mutationFn: async (params: {
      deviceAuthId: string;
      userCode: string;
    }): Promise<OpenaiCodexDevicePoll | null> => {
      const { data, error } = await openaiCodexDeviceAuthPoll({
        body: { deviceAuthId: params.deviceAuthId, userCode: params.userCode },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}
