import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

export function useMemberOptionsPage({
  search,
  searchMode = "name_or_email",
  enabled,
}: {
  search?: string;
  searchMode?: "name" | "name_or_email";
  enabled: boolean;
}) {
  return useInfiniteQuery({
    queryKey: ["organization", "member-options", "page", search, searchMode],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } =
        await archestraApiSdk.getOrganizationMemberOptions({
          signal,
          query: { search, searchMode, cursor: pageParam, limit: 20 },
        });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Member options are unavailable");
      return data;
    },
    getNextPageParam: (page) => page.pagination.nextCursor ?? undefined,
    enabled,
  });
}

/** Resolve only referenced identities; never enumerate the directory for labels. */
export function useMemberOptionsReferences({
  ids = [],
  emails = [],
}: {
  ids?: string[];
  emails?: string[];
}) {
  const uniqueIds = [...new Set(ids)].sort();
  const uniqueEmails = [
    ...new Set(emails.map((email) => email.toLowerCase())),
  ].sort();
  return useQuery({
    queryKey: [
      "organization",
      "member-options",
      "references",
      uniqueIds,
      uniqueEmails,
    ],
    queryFn: async ({ signal }) => {
      const rows: archestraApiTypes.GetOrganizationMemberOptionsResponses["200"]["data"] =
        [];
      for (const [field, values] of [
        ["ids", uniqueIds],
        ["emails", uniqueEmails],
      ] as const) {
        for (let offset = 0; offset < values.length; offset += 100) {
          const { data, error } =
            await archestraApiSdk.getOrganizationMemberOptions({
              signal,
              query: {
                [field]: values.slice(offset, offset + 100),
                limit: 100,
              },
            });
          throwOnApiError(error, { toastOnError: false });
          rows.push(...(data?.data ?? []));
        }
      }
      return [...new Map(rows.map((row) => [row.id, row])).values()];
    },
    enabled: uniqueIds.length > 0 || uniqueEmails.length > 0,
  });
}
