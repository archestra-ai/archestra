import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils/api";

const {
  listDefaultUserLimits,
  createDefaultUserLimit,
  updateDefaultUserLimit,
  deleteDefaultUserLimit,
  listUserLimitUsage,
  resetUserLimitUsage,
} = archestraApiSdk;

export type DefaultUserLimit =
  archestraApiTypes.ListDefaultUserLimitsResponses["200"][number];

type UpdateDefaultUserLimitParams =
  archestraApiTypes.UpdateDefaultUserLimitData["path"] &
    archestraApiTypes.UpdateDefaultUserLimitData["body"];
type DeleteDefaultUserLimitParams =
  archestraApiTypes.DeleteDefaultUserLimitData["path"];

export type UserLimitUsage =
  archestraApiTypes.ListUserLimitUsageResponses["200"]["data"][number];
export type UserLimitUsageSummary =
  archestraApiTypes.ListUserLimitUsageResponses["200"]["summary"];
export type UserLimitUsageFilters = Omit<
  NonNullable<archestraApiTypes.ListUserLimitUsageData["query"]>,
  "limit" | "offset"
>;

const QUERY_KEY = ["default-user-limits"] as const;
// Under "limits" so custom user limit mutations (limits.query.ts) refresh it.
const USER_USAGE_KEY = ["limits", "user-usage"] as const;

export function useDefaultUserLimits() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await listDefaultUserLimits();
      throwOnApiError(error);
      return data ?? [];
    },
  });
}

export function useCreateDefaultUserLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateDefaultUserLimitData["body"],
    ) => {
      const { data, error } = await createDefaultUserLimit({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: async (result) => {
      if (!result) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: USER_USAGE_KEY }),
      ]);
      toast.success("Default user limit created");
    },
  });
}

export function useUpdateDefaultUserLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateDefaultUserLimitParams) => {
      const { data, error } = await updateDefaultUserLimit({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: async (result) => {
      if (!result) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: USER_USAGE_KEY }),
      ]);
      toast.success("Default user limit updated");
    },
  });
}

export function useDeleteDefaultUserLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: DeleteDefaultUserLimitParams) => {
      const { data, error } = await deleteDefaultUserLimit({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? { success: true };
    },
    onSuccess: async (result) => {
      if (!result) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: USER_USAGE_KEY }),
      ]);
      toast.success("Default user limit deleted");
    },
  });
}

/** The first `limit` users, closest to their limit first, plus the summary. */
export function useUserLimitUsageTop(limit: number) {
  return useQuery({
    queryKey: [...USER_USAGE_KEY, "top", limit],
    queryFn: async () => {
      const { data, error } = await listUserLimitUsage({ query: { limit } });
      throwOnApiError(error);
      return data ?? null;
    },
  });
}

/** Every matching user, a page at a time, for the users drawer. */
export function useUserLimitUsagePages(params: {
  filters: UserLimitUsageFilters;
  pageSize: number;
  enabled: boolean;
}) {
  return useInfiniteQuery({
    queryKey: [...USER_USAGE_KEY, "pages", params.filters, params.pageSize],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await listUserLimitUsage({
        query: {
          ...params.filters,
          limit: params.pageSize,
          offset: pageParam,
        },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("User limit usage is unavailable");
      return data;
    },
    getNextPageParam: (page, pages) =>
      page.pagination.hasNext ? pages.length * params.pageSize : undefined,
    placeholderData: keepPreviousData,
    enabled: params.enabled,
  });
}

/**
 * Reset usage for the given users, or for everyone at their limit who matches
 * `allAtLimit`. Each user is reset (and audited) individually.
 */
export function useResetUserLimitUsage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      target:
        | { userIds: string[] }
        | { allAtLimit: Omit<UserLimitUsageFilters, "status"> },
    ) => {
      const userIds =
        "userIds" in target
          ? target.userIds
          : await listAtLimitUserIds(target.allAtLimit);
      const results = await Promise.all(
        userIds.map((userId) => resetUserLimitUsage({ path: { userId } })),
      );
      const failed = results.find((result) => result.error);
      if (failed?.error) handleApiError(failed.error);
      return {
        reset: results.filter((result) => !result.error).length,
      };
    },
    onSuccess: async ({ reset }) => {
      await queryClient.invalidateQueries({ queryKey: USER_USAGE_KEY });
      if (reset === 0) return;
      toast.success(
        reset === 1 ? "Usage reset" : `Usage reset for ${reset} users`,
      );
    },
  });
}

// ===
// Internal helpers

async function listAtLimitUserIds(
  filters: Omit<UserLimitUsageFilters, "status">,
): Promise<string[]> {
  const userIds: string[] = [];
  for (let offset = 0; ; offset += AT_LIMIT_PAGE_SIZE) {
    const { data, error } = await listUserLimitUsage({
      query: {
        ...filters,
        status: "at",
        limit: AT_LIMIT_PAGE_SIZE,
        offset,
      },
    });
    throwOnApiError(error);
    userIds.push(...(data?.data ?? []).map((row) => row.userId));
    if (!data?.pagination.hasNext) return userIds;
  }
}

const AT_LIMIT_PAGE_SIZE = 100;
