import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const {
  getApps,
  getApp,
  getExternalApp,
  getAppVersions,
  getAppTools,
  createApp,
  updateApp,
  deleteApp,
  assignToolToApp,
  unassignToolFromApp,
  openAppInChat,
  openExternalAppInChat,
} = archestraApiSdk;

type AppsQuery = NonNullable<archestraApiTypes.GetAppsData["query"]>;
type AppsParams = Pick<AppsQuery, "limit" | "offset" | "search">;

// ===== Query hooks =====

export function useApps(
  params: AppsParams,
  options?: { enabled?: boolean; toastOnError?: boolean },
) {
  const toastOnError = options?.toastOnError;
  return useQuery({
    queryKey: ["apps", "paginated", params],
    enabled: options?.enabled ?? true,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getApps({ query: params });
      throwOnApiError(error, { toastOnError });
      return data;
    },
  });
}

// Resolves an external UI-providing app by catalog id: its UI resource plus the
// caller's accessible installs and default install for the run-page selector.
export function useExternalApp(catalogId: string | null) {
  return useQuery({
    queryKey: ["apps", "external", catalogId],
    enabled: !!catalogId,
    queryFn: async () => {
      const { data, error } = await getExternalApp({
        path: { catalogId: catalogId as string },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
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
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
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
      throwOnApiError(error, { allowNotFound: true });
      return data ?? [];
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
      throwOnApiError(error, { allowNotFound: true });
      return data ?? [];
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

// Opens an existing app in chat: the backend creates a conversation with the app
// already rendered and returns its id to navigate to. No cache to invalidate —
// the caller navigates to `/chat/<conversationId>` on success.
export function useOpenAppInChat() {
  return useMutation({
    mutationFn: async (appId: string) => {
      const { data, error } = await openAppInChat({ path: { appId } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

// Opens an external (MCP-server) app in chat against a concrete install: the
// backend creates a conversation and returns its id plus how it was set up —
// `mode: "render"` (UI seeded inline) or `mode: "prompt"` (empty conversation
// plus an opening prompt for the caller to send, used when the tool has
// required inputs). The caller navigates to `/chat/<conversationId>` on
// success.
export function useOpenExternalAppInChat() {
  return useMutation({
    mutationFn: async (params: {
      mcpServerId: string;
      resourceUri: string;
    }) => {
      const { data, error } = await openExternalAppInChat({
        path: { mcpServerId: params.mcpServerId },
        body: { resourceUri: params.resourceUri },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
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
      // Visibility/environment edits write through to the app's backing catalog,
      // which drives the MCP registry card — refresh it too.
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
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
      // Deleting an app tears down its backing catalog — refresh the registry.
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
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
