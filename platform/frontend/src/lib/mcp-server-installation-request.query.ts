import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getMcpServerInstallationRequests,
  getMcpServerInstallationRequest,
  createMcpServerInstallationRequest,
  approveMcpServerInstallationRequest,
  declineMcpServerInstallationRequest,
  deleteMcpServerInstallationRequest,
  type GetMcpServerInstallationRequestsResponses,
  type GetMcpServerInstallationRequestResponses,
  type CreateMcpServerInstallationRequestData,
  type ApproveMcpServerInstallationRequestData,
  type DeclineMcpServerInstallationRequestData,
} from "@/lib/clients/api";

export function useMcpServerInstallationRequests(params?: {
  status?: "pending" | "approved" | "declined";
  initialData?: GetMcpServerInstallationRequestsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["mcp-server-installation-requests", params?.status],
    queryFn: async () => {
      const response = await getMcpServerInstallationRequests({
        query: params?.status ? { status: params.status } : undefined,
      });
      return response.data ?? [];
    },
    initialData: params?.initialData,
  });
}

export function useMcpServerInstallationRequest(
  id: string,
  params?: {
    initialData?: GetMcpServerInstallationRequestResponses["200"];
  },
) {
  return useSuspenseQuery({
    queryKey: ["mcp-server-installation-request", id],
    queryFn: async () => {
      const response = await getMcpServerInstallationRequest({ path: { id } });
      return response.data;
    },
    initialData: params?.initialData,
  });
}

export function useCreateMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateMcpServerInstallationRequestData["body"]) => {
      const response = await createMcpServerInstallationRequest({
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      toast.success("Installation request submitted successfully");
    },
    onError: (error) => {
      console.error("Create installation request error:", error);
      toast.error("Failed to submit installation request");
    },
  });
}

export function useApproveMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      id: string;
      reviewNotes?: string;
    }) => {
      const response = await approveMcpServerInstallationRequest({
        path: { id: data.id },
        body: { reviewNotes: data.reviewNotes },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request", variables.id],
      });
      toast.success("Installation request approved");
    },
    onError: (error) => {
      console.error("Approve installation request error:", error);
      toast.error("Failed to approve installation request");
    },
  });
}

export function useDeclineMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      id: string;
      reviewNotes?: string;
    }) => {
      const response = await declineMcpServerInstallationRequest({
        path: { id: data.id },
        body: { reviewNotes: data.reviewNotes },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request", variables.id],
      });
      toast.success("Installation request declined");
    },
    onError: (error) => {
      console.error("Decline installation request error:", error);
      toast.error("Failed to decline installation request");
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
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request", id],
      });
      toast.success("Installation request deleted");
    },
    onError: (error) => {
      console.error("Delete installation request error:", error);
      toast.error("Failed to delete installation request");
    },
  });
}
