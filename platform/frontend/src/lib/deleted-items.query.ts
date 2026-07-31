import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const { listDeletedItems, restoreDeletedItem, purgeDeletedItem } =
  archestraApiSdk;

export type DeletedItem =
  archestraApiTypes.ListDeletedItemsResponses["200"]["data"][number];
export type DeletedItemEntityType = DeletedItem["entityType"];

type ListParams = {
  entityTypes?: DeletedItemEntityType[];
  limit?: number;
  offset?: number;
};

export const deletedItemKeys = {
  all: ["deleted-items"] as const,
  list: (params: ListParams) =>
    [...deletedItemKeys.all, "list", params] as const,
};

export function useDeletedItems(params: ListParams = {}) {
  return useQuery({
    queryKey: deletedItemKeys.list(params),
    queryFn: async () => {
      const { data, error } = await listDeletedItems({
        query: {
          entityTypes: params.entityTypes,
          limit: params.limit ?? 20,
          offset: params.offset ?? 0,
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useRestoreDeletedItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: {
      entityType: DeletedItemEntityType;
      id: string;
    }) => {
      const { data, error } = await restoreDeletedItem({
        path: { entityType: item.entityType, id: item.id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      // The restored row rejoins its own list too, so invalidate broadly rather
      // than just the trash: a restored agent must reappear on /agents without
      // a reload.
      queryClient.invalidateQueries();
      toast.success("Item restored");
    },
  });
}

export function usePurgeDeletedItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: {
      entityType: DeletedItemEntityType;
      id: string;
    }) => {
      const { data, error } = await purgeDeletedItem({
        path: { entityType: item.entityType, id: item.id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deletedItemKeys.all });
      toast.success("Deleted permanently");
    },
  });
}
