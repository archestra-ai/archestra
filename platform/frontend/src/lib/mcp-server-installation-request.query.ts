import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const {
  addMcpServerInstallationRequestNote,
  approveMcpServerInstallationRequest,
  createMcpServerInstallationRequest,
  declineMcpServerInstallationRequest,
  deleteMcpServerInstallationRequest,
  getMcpServerInstallationRequest,
  getMcpServerInstallationRequests,
} = archestraApiSdk;

export type McpServerInstallationRequest =
  archestraApiTypes.GetMcpServerInstallationRequestResponses["200"];

type McpServerInstallationRequestsQuery = Partial<
  NonNullable<archestraApiTypes.GetMcpServerInstallationRequestsData["query"]>
>;
type ApproveInstallationRequestParams =
  archestraApiTypes.ApproveMcpServerInstallationRequestData["path"] &
    NonNullable<
      archestraApiTypes.ApproveMcpServerInstallationRequestData["body"]
    >;
type DeclineInstallationRequestParams =
  archestraApiTypes.DeclineMcpServerInstallationRequestData["path"] &
    NonNullable<
      archestraApiTypes.DeclineMcpServerInstallationRequestData["body"]
    >;
type AddInstallationRequestNoteParams =
  archestraApiTypes.AddMcpServerInstallationRequestNoteData["path"] &
    NonNullable<
      archestraApiTypes.AddMcpServerInstallationRequestNoteData["body"]
    >;

export function useMcpServerInstallationRequests(
  params?: McpServerInstallationRequestsQuery,
) {
  return useQuery({
    queryKey: ["mcp-server-installation-requests", params?.status],
    queryFn: async () => {
      const response = await getMcpServerInstallationRequests({
        query: params?.status ? { status: params.status } : undefined,
      });
      return response.data ?? null;
    },
  });
}

export function useMcpServerInstallationRequest(id: string) {
  return useQuery({
    queryKey: ["mcp-server-installation-request", id],
    queryFn: async () => {
      const response = await getMcpServerInstallationRequest({
        path: { id },
      });
      return response.data ?? null;
    },
    enabled: !!id,
  });
}

export function useCreateMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateMcpServerInstallationRequestData["body"],
    ) => {
      const response = await createMcpServerInstallationRequest({
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      toast.success("Installation request created successfully");
    },
    onError: (error: Error) => {
      console.error("Create request error:", error);
      toast.error(error.message || "Failed to create installation request");
    },
  });
}

export function useApproveMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      adminResponse,
    }: ApproveInstallationRequestParams) => {
      const response = await approveMcpServerInstallationRequest({
        path: { id },
        body: adminResponse ? { adminResponse } : {},
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-catalog"],
      });
      toast.success("Installation request approved successfully");
    },
    onError: (error: Error) => {
      console.error("Approve request error:", error);
      toast.error("Failed to approve installation request");
    },
  });
}

export function useDeclineMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      adminResponse,
    }: DeclineInstallationRequestParams) => {
      const response = await declineMcpServerInstallationRequest({
        path: { id },
        body: adminResponse ? { adminResponse } : {},
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request"],
      });
      toast.success("Installation request declined");
    },
    onError: (error: Error) => {
      console.error("Decline request error:", error);
      toast.error("Failed to decline installation request");
    },
  });
}

export function useAddMcpServerInstallationRequestNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, content }: AddInstallationRequestNoteParams) => {
      const response = await addMcpServerInstallationRequestNote({
        path: { id },
        body: { content },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request", variables.id],
      });
      toast.success("Note added successfully");
    },
    onError: (error: Error) => {
      console.error("Add note error:", error);
      toast.error("Failed to add note");
    },
  });
}

export function useDeleteMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteMcpServerInstallationRequest({
        path: { id },
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      toast.success("Installation request deleted successfully");
    },
    onError: (error: Error) => {
      console.error("Delete request error:", error);
      toast.error("Failed to delete installation request");
    },
  });
}
