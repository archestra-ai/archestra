import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  useQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";

// Types for the installation request (matching backend types)
export type McpServerInstallationRequest = {
  id: string;
  catalogId: string;
  requestedBy: string;
  status: "pending" | "approved" | "declined";
  requestReason?: string;
  adminResponse?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  notes: Array<{
    id: string;
    userId: string;
    userName: string;
    content: string;
    createdAt: string;
  }> | null;
  createdAt: Date;
  updatedAt: Date;
};

// API client functions (will be auto-generated later, defining manually for now)
async function getMcpServerInstallationRequests(params?: {
  status?: "pending" | "approved" | "declined";
}) {
  const queryParams = new URLSearchParams();
  if (params?.status) {
    queryParams.append("status", params.status);
  }
  const response = await fetch(
    `/api/mcp_server_installation_requests?${queryParams.toString()}`,
    {
      credentials: "include",
    }
  );
  if (!response.ok) {
    throw new Error("Failed to fetch installation requests");
  }
  return response.json();
}

async function getMcpServerInstallationRequest(id: string) {
  const response = await fetch(`/api/mcp_server_installation_requests/${id}`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch installation request");
  }
  return response.json();
}

async function createMcpServerInstallationRequest(data: {
  catalogId: string;
  requestReason?: string;
}) {
  const response = await fetch("/api/mcp_server_installation_requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to create request");
  }
  return response.json();
}

async function approveMcpServerInstallationRequest(
  id: string,
  adminResponse?: string
) {
  const response = await fetch(
    `/api/mcp_server_installation_requests/${id}/approve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ adminResponse }),
    }
  );
  if (!response.ok) {
    throw new Error("Failed to approve request");
  }
  return response.json();
}

async function declineMcpServerInstallationRequest(
  id: string,
  adminResponse?: string
) {
  const response = await fetch(
    `/api/mcp_server_installation_requests/${id}/decline`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ adminResponse }),
    }
  );
  if (!response.ok) {
    throw new Error("Failed to decline request");
  }
  return response.json();
}

async function addMcpServerInstallationRequestNote(
  id: string,
  content: string
) {
  const response = await fetch(
    `/api/mcp_server_installation_requests/${id}/notes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ content }),
    }
  );
  if (!response.ok) {
    throw new Error("Failed to add note");
  }
  return response.json();
}

async function deleteMcpServerInstallationRequest(id: string) {
  const response = await fetch(`/api/mcp_server_installation_requests/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to delete request");
  }
  return response.json();
}

// Query hooks
export function useMcpServerInstallationRequests(params?: {
  status?: "pending" | "approved" | "declined";
}) {
  return useQuery({
    queryKey: ["mcp-server-installation-requests", params?.status],
    queryFn: () => getMcpServerInstallationRequests(params),
  });
}

export function useMcpServerInstallationRequest(id: string) {
  return useQuery({
    queryKey: ["mcp-server-installation-request", id],
    queryFn: () => getMcpServerInstallationRequest(id),
    enabled: !!id,
  });
}

export function useCreateMcpServerInstallationRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createMcpServerInstallationRequest,
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
    mutationFn: ({
      id,
      adminResponse,
    }: {
      id: string;
      adminResponse?: string;
    }) => approveMcpServerInstallationRequest(id, adminResponse),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-requests"],
      });
      queryClient.invalidateQueries({
        queryKey: ["mcp-server-installation-request"],
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
    mutationFn: ({
      id,
      adminResponse,
    }: {
      id: string;
      adminResponse?: string;
    }) => declineMcpServerInstallationRequest(id, adminResponse),
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
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      addMcpServerInstallationRequestNote(id, content),
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
    mutationFn: deleteMcpServerInstallationRequest,
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
