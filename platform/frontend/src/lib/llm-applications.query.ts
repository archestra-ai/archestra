import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

const {
  getLlmApplications,
  createLlmApplication,
  rotateLlmApplicationSecret,
  deleteLlmApplication,
} = archestraApiSdk;

export function useLlmApplications() {
  return useQuery({
    queryKey: ["llm-applications"],
    queryFn: async () => {
      const { data, error } = await getLlmApplications();
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
  });
}

export function useCreateLlmApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateLlmApplicationData["body"],
    ) => {
      const { data, error } = await createLlmApplication({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Application created");
      queryClient.invalidateQueries({ queryKey: ["llm-applications"] });
    },
  });
}

export function useRotateLlmApplicationSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await rotateLlmApplicationSecret({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Application secret rotated");
      queryClient.invalidateQueries({ queryKey: ["llm-applications"] });
    },
  });
}

export function useDeleteLlmApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data, error } = await deleteLlmApplication({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Application deleted");
      queryClient.invalidateQueries({ queryKey: ["llm-applications"] });
    },
  });
}
