import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type SiteAnnouncement = NonNullable<
  archestraApiTypes.GetSiteAnnouncementResponse["announcement"]
>;

export type SiteAnnouncementPayload =
  archestraApiTypes.CreateSiteAnnouncementData["body"];

const siteAnnouncementKeys = {
  all: ["site-announcement"] as const,
  active: () => [...siteAnnouncementKeys.all, "active"] as const,
  settings: () => [...siteAnnouncementKeys.all, "settings"] as const,
};

export function useActiveSiteAnnouncement(enabled: boolean) {
  return useQuery({
    queryKey: siteAnnouncementKeys.active(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getSiteAnnouncement();
      if (error || !data) {
        throw new Error("Failed to load site announcement");
      }
      return data.announcement;
    },
    enabled,
    staleTime: 60 * 1000,
  });
}

export function useSiteAnnouncementSettings() {
  return useQuery({
    queryKey: siteAnnouncementKeys.settings(),
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getSiteAnnouncementSettings();
      if (error || !data) {
        throw new Error("Failed to load site announcement settings");
      }
      return data.announcement;
    },
  });
}

export function useSaveSiteAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      mode,
      payload,
    }: {
      mode: "create" | "update";
      payload: SiteAnnouncementPayload;
    }) => {
      const request =
        mode === "create"
          ? archestraApiSdk.createSiteAnnouncement({ body: payload })
          : archestraApiSdk.updateSiteAnnouncement({ body: payload });
      const { data, error } = await request;
      if (error || !data) {
        throw new Error("Failed to save site announcement");
      }
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: siteAnnouncementKeys.all }),
      ]);
      toast.success("Site announcement saved");
    },
    onError: (error) => {
      toast.error("Failed to save site announcement", {
        description: error.message,
      });
    },
  });
}

export function useDeleteSiteAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await archestraApiSdk.deleteSiteAnnouncement();
      if (error) {
        throw new Error("Failed to delete site announcement");
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: siteAnnouncementKeys.all }),
      ]);
      toast.success("Site announcement deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete site announcement", {
        description: error.message,
      });
    },
  });
}
