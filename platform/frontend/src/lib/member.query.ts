import {
  archestraApiSdk,
  type archestraApiTypes,
  calculatePaginationMeta,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { UserSelectOption } from "@/components/user-select-option";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { throwOnApiError } from "@/lib/utils";
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
type RawInvitation = NonNullable<
  Awaited<ReturnType<typeof authClient.organization.listInvitations>>["data"]
>[number];

/**
 * Paginated members hook with search and role filter support
 */
export function useMembersPaginated(
  query: Required<Pick<MembersQuery, "limit" | "offset">> &
    Pick<MembersQuery, "name" | "role">,
  options?: { enabled?: boolean },
) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: memberKeys.paginated(query),
    queryFn: async () => {
      const response = await getMembers({ query });
      throwOnApiError(response.error, { toastOnError: false });
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
 * Server-side member search for the user pickers.
 *
 * Every picker needs the same three things — debounce the keystrokes, ask the
 * API instead of filtering a locally-held roster, and keep the currently
 * selected user in the list even when the active query no longer matches them
 * (otherwise the trigger falls back to a bare id or an empty label). Owning
 * that here keeps the pickers from re-deriving it, each slightly differently.
 *
 * Pass `selectedUserIds` so the selection is retained; pass `enabled: false`
 * to hold the request back until a dialog is actually open.
 */
export function useMemberSearch({
  selectedUserIds = [],
  limit = 50,
  enabled = true,
}: {
  selectedUserIds?: string[];
  limit?: number;
  enabled?: boolean;
} = {}) {
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebouncedValue(searchQuery, 250);
  const { data, isFetching } = useMembersPaginated(
    { limit, offset: 0, name: debouncedSearch || undefined },
    { enabled },
  );

  const results = useMemo(
    () =>
      (data?.data ?? []).map((member) => ({
        userId: member.userId,
        name: member.name,
        email: member.email,
      })),
    [data],
  );

  // Remember everyone we've rendered so a selection made under an earlier
  // query can still be labelled under the current one.
  const seenUsers = useRef<Record<string, UserSelectOption>>({});
  for (const user of results) {
    seenUsers.current[user.userId] = user;
  }

  // Cheap enough to redo each render, and no consumer keys an effect off this
  // list — so it stays plain rather than memoised on a hand-rolled key derived
  // from the (freshly allocated every render) selectedUserIds array.
  const present = new Set(results.map((user) => user.userId));
  const retained = selectedUserIds
    .filter((userId) => !present.has(userId))
    .map((userId) => seenUsers.current[userId])
    .filter((user): user is UserSelectOption => Boolean(user));
  const users = [...retained, ...results];

  // True while the typed query is still debouncing or its fetch is in flight,
  // so a picker can say "Searching…" instead of a premature "no results".
  const isSearching = searchQuery !== debouncedSearch || isFetching;

  return {
    users,
    isSearching,
    onSearchQueryChange: setSearchQuery,
    emptyMessage: isSearching ? "Searching…" : "No matching users found.",
  };
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
          ?.filter(
            (invitation: RawInvitation) => invitation.status === "pending",
          )
          .map((invitation: RawInvitation) => ({
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
        // better-auth's client types only admit its built-in role names;
        // custom and platform-defined roles pass through as plain strings.
        role: role as Parameters<
          typeof authClient.organization.updateMemberRole
        >[0]["role"],
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
