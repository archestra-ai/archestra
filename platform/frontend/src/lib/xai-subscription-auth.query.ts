import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { xaiSubscriptionDeviceAuthStart, xaiSubscriptionDeviceAuthPoll } =
  archestraApiSdk;

export type XaiSubscriptionDeviceStart =
  archestraApiTypes.XaiSubscriptionDeviceAuthStartResponses["200"];
export type XaiSubscriptionDevicePoll =
  archestraApiTypes.XaiSubscriptionDeviceAuthPollResponses["200"];

export function useStartXaiSubscriptionDeviceFlow() {
  return useMutation({
    mutationFn: async (): Promise<XaiSubscriptionDeviceStart | null> => {
      // Toast even when the SDK call throws (network down, backend restarting)
      // instead of returning an API error — otherwise the sign-in button fails
      // with no feedback at all.
      try {
        const { data, error } = await xaiSubscriptionDeviceAuthStart();
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

export function usePollXaiSubscriptionDeviceFlow() {
  return useMutation({
    mutationFn: async (params: {
      deviceCode: string;
    }): Promise<XaiSubscriptionDevicePoll | null> => {
      const { data, error } = await xaiSubscriptionDeviceAuthPoll({
        body: { deviceCode: params.deviceCode },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}
