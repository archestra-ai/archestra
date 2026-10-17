import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "./utils";

export const siteNotificationKeys = {
  all: ["site-notification"] as const,
  active: () => [...siteNotificationKeys.all, "active"] as const,
  settings: () => [...siteNotificationKeys.all, "settings"] as const,
};

export type SiteNotification = NonNullable<
  archestraApiTypes.GetSiteNotificationResponses["200"]
>;
type UpdateSiteNotificationOptions = Omit<
  archestraApiTypes.UpdateSiteNotificationData,
  "url"
>;
type DeleteSiteNotificationOptions = Omit<
  archestraApiTypes.DeleteSiteNotificationData,
  "url"
>;

export function useActiveSiteNotification(
  options?: Pick<
    UseQueryOptions<SiteNotification | null>,
    "enabled" | "staleTime" | "refetchOnWindowFocus"
  >,
) {
  return useQuery({
    queryKey: siteNotificationKeys.active(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getSiteNotification();
      throwOnApiError(error, { toastOnError: false });
      return data as SiteNotification | null;
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
    ...options,
  });
}

export function useSiteNotification(
  options?: Pick<
    UseQueryOptions<SiteNotification | null>,
    "enabled" | "staleTime" | "refetchOnWindowFocus"
  >,
) {
  return useQuery({
    queryKey: siteNotificationKeys.settings(),
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getSiteNotificationSettings();
      throwOnApiError(error, { toastOnError: false });
      return data as SiteNotification | null;
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
    ...options,
  });
}

export function useCreateSiteNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateSiteNotificationData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.createSiteNotification({
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as SiteNotification;
    },
    onSuccess: (notification) => {
      if (!notification) return;
      queryClient.setQueryData(siteNotificationKeys.settings(), notification);
      queryClient.setQueryData(siteNotificationKeys.active(), notification);
      toast.success("Notification created");
    },
    onError: () => {
      // handleApiError already called
    },
  });
}

export function useUpdateSiteNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: UpdateSiteNotificationOptions) => {
      const { data, error } =
        await archestraApiSdk.updateSiteNotification(params);
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as SiteNotification;
    },
    onSuccess: (notification) => {
      if (!notification) return;
      queryClient.setQueryData(siteNotificationKeys.settings(), notification);
      queryClient.setQueryData(
        siteNotificationKeys.active(),
        notification.isActive ? notification : null,
      );
      toast.success("Notification updated");
    },
    onError: () => {
      // handleApiError already called
    },
  });
}

export function useDeleteSiteNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: DeleteSiteNotificationOptions) => {
      const { error } = await archestraApiSdk.deleteSiteNotification(params);
      if (error) {
        handleApiError(error);
        return false;
      }
      return true;
    },
    onSuccess: (success) => {
      if (!success) return;
      queryClient.setQueryData(siteNotificationKeys.settings(), null);
      queryClient.setQueryData(siteNotificationKeys.active(), null);
      toast.success("Notification deleted");
    },
    onError: () => {
      // handleApiError already called
    },
  });
}
