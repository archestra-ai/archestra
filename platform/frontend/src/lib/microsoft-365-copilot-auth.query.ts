import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const {
  microsoft365CopilotDeviceAuthStart,
  microsoft365CopilotDeviceAuthPoll,
} = archestraApiSdk;

export type Microsoft365CopilotDeviceStart =
  archestraApiTypes.Microsoft365CopilotDeviceAuthStartResponses["200"];
export type Microsoft365CopilotDevicePoll =
  archestraApiTypes.Microsoft365CopilotDeviceAuthPollResponses["200"];

export function useStartMicrosoft365CopilotDeviceFlow() {
  return useMutation({
    mutationFn: async (): Promise<Microsoft365CopilotDeviceStart | null> => {
      // Toast even when the SDK call throws (network down, backend
      // restarting) instead of returning an API error — otherwise the
      // sign-in button fails with no feedback at all.
      try {
        const { data, error } = await microsoft365CopilotDeviceAuthStart();
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

export function usePollMicrosoft365CopilotDeviceFlow() {
  return useMutation({
    mutationFn: async (
      deviceCode: string,
    ): Promise<Microsoft365CopilotDevicePoll | null> => {
      const { data, error } = await microsoft365CopilotDeviceAuthPoll({
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
