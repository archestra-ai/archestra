"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type SiteAnnouncement = {
  id: string;
  organizationId: string;
  markdown: string;
  expiresAt: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const siteAnnouncementKeys = {
  all: ["site-announcement"] as const,
  current: () => [...siteAnnouncementKeys.all, "current"] as const,
  active: () => [...siteAnnouncementKeys.all, "active"] as const,
};

async function fetchSiteAnnouncement(path: string) {
  const response = await fetch(path);
  if (response.status === 403 || response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Failed to load site announcement");
  }
  return (await response.json()) as SiteAnnouncement | null;
}

export function useSiteAnnouncement() {
  return useQuery({
    queryKey: siteAnnouncementKeys.current(),
    queryFn: () => fetchSiteAnnouncement("/api/site-announcement"),
    retry: false,
  });
}

export function useActiveSiteAnnouncement() {
  return useQuery({
    queryKey: siteAnnouncementKeys.active(),
    queryFn: () => fetchSiteAnnouncement("/api/site-announcement/active"),
    retry: false,
    throwOnError: false,
  });
}

export function useUpsertSiteAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      markdown: string;
      expiresAt: string | null;
    }) => {
      const response = await fetch("/api/site-announcement", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error("Failed to save site announcement");
      }
      return (await response.json()) as SiteAnnouncement;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: siteAnnouncementKeys.all });
      toast.success("Site announcement saved");
    },
    onError: () => {
      toast.error("Failed to save site announcement");
    },
  });
}

export function useDeleteSiteAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/site-announcement", {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error("Failed to delete site announcement");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: siteAnnouncementKeys.all });
      toast.success("Site announcement deleted");
    },
    onError: () => {
      toast.error("Failed to delete site announcement");
    },
  });
}
