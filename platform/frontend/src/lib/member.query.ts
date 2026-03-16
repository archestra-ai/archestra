import {
  archestraApiSdk,
  type archestraApiTypes,
  calculatePaginationMeta,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useActiveOrganization } from "./organization.query";

const { getMembers } = archestraApiSdk;

/**
 * Query keys for member/invitation queries
 */
export const memberKeys = {
  all: ["members"] as const,
  lists: () => [...memberKeys.all, "list"] as const,
  paginated: (query: Record<string, string | number | undefined>) =>
    [...memberKeys.lists(), "paginated", query] as const,
};

export const invitationKeys = {
  all: ["invitations-paginated"] as const,
  lists: () => [...invitationKeys.all, "list"] as const,
  paginated: (query: Record<string, string | number | undefined>) =>
    [...invitationKeys.lists(), "paginated", query] as const,
};

type MembersQuery = NonNullable<archestraApiTypes.GetMembersData["query"]>;
type MembersResponse = archestraApiTypes.GetMembersResponses["200"];
export type Member = MembersResponse["data"][number];

type InvitationsQuery = NonNullable<{ limit: number; offset: number }>;
export type Invitation = {
  id: string;
  email: string;
  role: string | null;
  expiresAt: string;
  status: string;
};
type PaginatedInvitationsResponse = {
  data: Invitation[];
  pagination: {
    currentPage: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
};

/**
 * Paginated members hook with search and role filter support
 */
export function useMembersPaginated(
  query: Required<Pick<MembersQuery, "limit" | "offset">> &
    Pick<MembersQuery, "name" | "role">,
) {
  return useQuery({
    queryKey: memberKeys.paginated(query),
    queryFn: async () => {
      const response = await getMembers({ query });
      return (
        response.data ?? {
          data: [] as Member[],
          pagination: {
            currentPage: 1,
            limit: query.limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
  });
}

/**
 * Paginated invitations hook (pending invitations only)
 */
export function useInvitationsPaginated(
  query: Required<Pick<InvitationsQuery, "limit" | "offset">>,
) {
  const { data: activeOrganization } = useActiveOrganization();

  return useQuery<PaginatedInvitationsResponse>({
    queryKey: invitationKeys.paginated({
      ...query,
      organizationId: activeOrganization?.id,
    }),
    queryFn: async () => {
      if (!activeOrganization?.id) {
        return buildEmptyPaginatedInvitations(query);
      }

      const response = await authClient.organization.listInvitations({
        query: { organizationId: activeOrganization.id },
      });
      const allInvitations: Invitation[] =
        response.data
          ?.filter((invitation) => invitation.status === "pending")
          .map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role ?? null,
            expiresAt:
              invitation.expiresAt?.toISOString() ?? new Date().toISOString(),
            status: invitation.status,
          })) ?? [];

      const paginatedInvitations = allInvitations.slice(
        query.offset,
        query.offset + query.limit,
      );

      return {
        data: paginatedInvitations,
        pagination: calculatePaginationMeta(allInvitations.length, {
          limit: query.limit,
          offset: query.offset,
        }),
      };
    },
    enabled: !!activeOrganization?.id,
  });
}

/**
 * Update a member's role via better-auth
 */
export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      memberId,
      role,
    }: {
      memberId: string;
      role: string;
    }) => {
      const response = await authClient.organization.updateMemberRole({
        memberId,
        role: role as "admin" | "member",
      });
      if (response.error) {
        throw new Error(response.error.message ?? "Failed to update role");
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.lists() });
      toast.success("Member role updated");
    },
    onError: (error: Error) => {
      toast.error("Failed to update role", { description: error.message });
    },
  });
}

/**
 * Remove a member from the organization via better-auth
 */
export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (memberId: string) => {
      const response = await authClient.organization.removeMember({
        memberIdOrEmail: memberId,
      });
      if (response.error) {
        throw new Error(response.error.message ?? "Failed to remove member");
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.lists() });
      toast.success("Member removed");
    },
    onError: (error: Error) => {
      toast.error("Failed to remove member", { description: error.message });
    },
  });
}

/**
 * Cancel/revoke a pending invitation via better-auth
 */
export function useCancelInvitationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await authClient.organization.cancelInvitation({
        invitationId,
      });
      if (response.error) {
        throw new Error(
          response.error.message ?? "Failed to cancel invitation",
        );
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: invitationKeys.lists() });
      toast.success("Invitation cancelled");
    },
    onError: (error: Error) => {
      toast.error("Failed to cancel invitation", {
        description: error.message,
      });
    },
  });
}

function buildEmptyPaginatedInvitations(query: InvitationsQuery) {
  return {
    data: [] as Invitation[],
    pagination: calculatePaginationMeta(0, {
      limit: query.limit,
      offset: query.offset,
    }),
  };
}
