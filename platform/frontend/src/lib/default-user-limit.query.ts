import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  listDefaultUserLimits,
  createDefaultUserLimit,
  updateDefaultUserLimit,
  deleteDefaultUserLimit,
} = archestraApiSdk;

export type DefaultUserLimit =
  archestraApiTypes.ListDefaultUserLimitsResponses["200"][number];

type UpdateDefaultUserLimitParams =
  archestraApiTypes.UpdateDefaultUserLimitData["path"] &
    archestraApiTypes.UpdateDefaultUserLimitData["body"];
type DeleteDefaultUserLimitParams =
  archestraApiTypes.DeleteDefaultUserLimitData["path"];

const QUERY_KEY = ["default-user-limits"] as const;

export function useDefaultUserLimits() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await listDefaultUserLimits();
      if (error) {
        handleApiError(error);
        return [];
      }
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
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
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
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
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
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Default user limit deleted");
    },
  });
}
