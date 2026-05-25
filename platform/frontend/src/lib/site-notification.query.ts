import { archestraApiSdk } from "@shared";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

export const siteNotificationKeys = {
  all: ["site-notification"] as const,
  active: () => [...siteNotificationKeys.all, "active"] as const,
  settings: () => [...siteNotificationKeys.all, "settings"] as const,
};

export interface SiteNotification {
  id: string;
  content: string;
  expiresAt: string | null;
  createdAt: string;
  isActive: boolean;
}

export function useActiveSiteNotification() {
  return useQuery({
    queryKey: siteNotificationKeys.active(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getSiteNotification();
      if (error) {
        return null;
      }
      return data as SiteNotification | null;
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
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
      if (error) {
        return null;
      }
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
    mutationFn: async (params: { content: string; expiresAt?: string }) => {
      const { data, error } = await archestraApiSdk.createSiteNotification({
        body: params,
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
    mutationFn: async (params: {
      id: string;
      content?: string;
      expiresAt?: string | null;
      isActive?: boolean;
    }) => {
      const { data, error } = await archestraApiSdk.updateSiteNotification({
        path: { id: params.id },
        body: {
          content: params.content,
          expiresAt: params.expiresAt,
          isActive: params.isActive,
        },
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
    mutationFn: async (id: string) => {
      const { error } = await archestraApiSdk.deleteSiteNotification({
        path: { id },
      });
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
