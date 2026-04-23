import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useFeature } from "@/lib/config/config.query";
import { handleApiError } from "@/lib/utils";

const {
  listMemory,
  listPendingMemory,
  getMemory,
  getMemoryStats,
  createMemory,
  updateMemory,
  supersedeMemory,
  approveMemory,
  rejectMemory,
  archiveMemory,
  unarchiveMemory,
  deleteMemory,
} = archestraApiSdk;

type MemoryListQuery = NonNullable<archestraApiTypes.ListMemoryData["query"]>;
type PendingMemoryListQuery = NonNullable<
  archestraApiTypes.ListPendingMemoryData["query"]
>;
type MemoryPaginatedResponse = archestraApiTypes.ListMemoryResponses["200"];
type PendingMemoryPaginatedResponse =
  archestraApiTypes.ListPendingMemoryResponses["200"];
type MemoryStatsResponse = archestraApiTypes.GetMemoryStatsResponses["200"];

type UpdateMemoryCandidateInput = {
  id: string;
  body: archestraApiTypes.UpdateMemoryData["body"];
};

type SupersedeMemoryInput = {
  id: string;
  body: archestraApiTypes.SupersedeMemoryData["body"];
};

type RejectMemoryInput = {
  id: string;
  body: archestraApiTypes.RejectMemoryData["body"];
};

export const memoryKeys = {
  all: ["memory"] as const,
  listPrefix: () => [...memoryKeys.all, "list"] as const,
  list: (params: MemoryListQuery) =>
    [...memoryKeys.listPrefix(), params] as const,
  pendingListPrefix: () => [...memoryKeys.all, "pending-list"] as const,
  pendingList: (params: PendingMemoryListQuery) =>
    [...memoryKeys.pendingListPrefix(), params] as const,
  detail: (id: string) => [...memoryKeys.all, "detail", id] as const,
  stats: () => [...memoryKeys.all, "stats"] as const,
};

export function useMemoryPaginated(params: MemoryListQuery) {
  const queryParams = {
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
    scopeType: params.scopeType,
    status: params.status,
    kind: params.kind,
    search: params.search,
  } satisfies MemoryListQuery;

  return useQuery({
    queryKey: memoryKeys.list(queryParams),
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await listMemory({ query: queryParams });
      if (error) {
        handleApiError(error);
        return EMPTY_MEMORY_LIST;
      }
      return data ?? EMPTY_MEMORY_LIST;
    },
  });
}

export function usePendingMemoryPaginated(params: PendingMemoryListQuery) {
  const queryParams = {
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  } satisfies PendingMemoryListQuery;

  return useQuery({
    queryKey: memoryKeys.pendingList(queryParams),
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await listPendingMemory({ query: queryParams });
      if (error) {
        handleApiError(error);
        return EMPTY_PENDING_MEMORY_LIST;
      }
      return data ?? EMPTY_PENDING_MEMORY_LIST;
    },
  });
}

export function useMemory(id: string) {
  return useQuery({
    queryKey: memoryKeys.detail(id),
    queryFn: async () => {
      const { data, error } = await getMemory({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    enabled: !!id,
  });
}

export function useMemoryStats() {
  return useQuery({
    queryKey: memoryKeys.stats(),
    queryFn: async () => {
      const { data, error } = await getMemoryStats();
      if (error) {
        handleApiError(error);
        return EMPTY_MEMORY_STATS;
      }
      return data ?? EMPTY_MEMORY_STATS;
    },
  });
}

export function useCreateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateMemoryData["body"]) => {
      const { data, error } = await createMemory({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success("Memory candidate created");
      await invalidateMemoryCollections(queryClient);
    },
    onError: (_error) => {
      toast.error("Failed to create memory candidate");
    },
  });
}

export function useUpdateMemoryCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: UpdateMemoryCandidateInput) => {
      const { data, error } = await updateMemory({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, variables) => {
      if (!data) return;
      toast.success("Memory candidate updated");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(variables.id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to update memory candidate");
    },
  });
}

export function useSupersedeMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: SupersedeMemoryInput) => {
      const { data, error } = await supersedeMemory({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, variables) => {
      if (!data) return;
      toast.success("Superseding memory candidate created");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(variables.id),
      });
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(data.id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to create superseding memory candidate");
    },
  });
}

export function useApproveMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await approveMemory({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, id) => {
      if (!data) return;
      toast.success("Memory candidate approved");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to approve memory candidate");
    },
  });
}

export function useRejectMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: RejectMemoryInput) => {
      const { data, error } = await rejectMemory({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, variables) => {
      if (!data) return;
      toast.success("Memory candidate rejected");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(variables.id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to reject memory candidate");
    },
  });
}

export function useArchiveMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archiveMemory({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, id) => {
      if (!data) return;
      toast.success("Memory archived");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to archive memory");
    },
  });
}

export function useUnarchiveMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await unarchiveMemory({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, id) => {
      if (!data) return;
      toast.success("Memory restored");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to restore memory");
    },
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteMemory({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: async (data, id) => {
      if (!data?.success) return;
      toast.success("Memory deleted");
      await invalidateMemoryCollections(queryClient);
      await queryClient.invalidateQueries({
        queryKey: memoryKeys.detail(id),
      });
    },
    onError: (_error) => {
      toast.error("Failed to delete memory");
    },
  });
}

export function useMemoryExtractionEnabled() {
  return useFeature("memoryExtractionEnabled");
}

export function useMemoryInjectionEnabled() {
  return useFeature("memoryInjectionEnabled");
}

export function useMemoryExtractionAvailable() {
  return useFeature("memoryExtractionAvailable");
}

async function invalidateMemoryCollections(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: memoryKeys.listPrefix() });
  await queryClient.invalidateQueries({
    queryKey: memoryKeys.pendingListPrefix(),
  });
  await queryClient.invalidateQueries({ queryKey: memoryKeys.stats() });
}

const EMPTY_MEMORY_LIST: MemoryPaginatedResponse = {
  data: [],
  pagination: {
    currentPage: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
};

const EMPTY_PENDING_MEMORY_LIST: PendingMemoryPaginatedResponse = {
  data: [],
  pagination: {
    currentPage: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
};

const EMPTY_MEMORY_STATS: MemoryStatsResponse = {
  candidate: 0,
  approved: 0,
  rejected: 0,
  archived: 0,
};
