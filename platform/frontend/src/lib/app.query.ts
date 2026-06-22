import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  getApps,
  getApp,
  getAppVersions,
  getAppTools,
  createApp,
  updateApp,
  deleteApp,
  assignToolToApp,
  unassignToolFromApp,
} = archestraApiSdk;

type AppsQuery = NonNullable<archestraApiTypes.GetAppsData["query"]>;
type AppsParams = Pick<AppsQuery, "limit" | "offset" | "search">;

// ===== Query hooks =====

export function useApps(params: AppsParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["apps", "paginated", params],
    enabled: options?.enabled ?? true,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getApps({ query: params });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useApp(appId: string | null) {
  return useQuery({
    queryKey: ["apps", appId],
    enabled: !!appId,
    queryFn: async () => {
      const { data, error } = await getApp({
        path: { appId: appId as string },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useAppVersions(appId: string | null) {
  return useQuery({
    queryKey: ["apps", appId, "versions"],
    enabled: !!appId,
    queryFn: async () => {
      const { data, error } = await getAppVersions({
        path: { appId: appId as string },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data;
    },
  });
}

export function useAppTools(appId: string | null) {
  return useQuery({
    queryKey: ["apps", appId, "tools"],
    enabled: !!appId,
    queryFn: async () => {
      const { data, error } = await getAppTools({
        path: { appId: appId as string },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data;
    },
  });
}

// ===== Mutation hooks =====

export function useCreateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateAppData["body"]) => {
      const { data, error } = await createApp({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      toast.success("App created");
    },
  });
}

export function useUpdateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      appId,
      body,
    }: {
      appId: string;
      body: archestraApiTypes.UpdateAppData["body"];
    }) => {
      const { data, error } = await updateApp({ path: { appId }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["apps", variables.appId] });
      toast.success("App updated");
    },
  });
}

export function useDeleteApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (appId: string) => {
      const { data, error } = await deleteApp({ path: { appId } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      toast.success("App deleted");
    },
  });
}

export function useAssignToolToApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      appId,
      toolId,
      body,
    }: {
      appId: string;
      toolId: string;
      body: archestraApiTypes.AssignToolToAppData["body"];
    }) => {
      const { data, error } = await assignToolToApp({
        path: { appId, toolId },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["apps", variables.appId, "tools"],
      });
    },
  });
}

export function useUnassignToolFromApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      appId,
      toolId,
    }: {
      appId: string;
      toolId: string;
    }) => {
      const { data, error } = await unassignToolFromApp({
        path: { appId, toolId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["apps", variables.appId, "tools"],
      });
    },
  });
}
