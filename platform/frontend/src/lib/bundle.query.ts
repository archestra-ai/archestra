import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const { createBundle, deleteBundle, getBundle, getBundles, updateBundle } =
  archestraApiSdk;

export type Bundle = archestraApiTypes.GetBundleResponses["200"];
export type CreateBundleBody = archestraApiTypes.CreateBundleData["body"];
export type UpdateBundleBody = archestraApiTypes.UpdateBundleData["body"];

const queryKey = ["bundles"] as const;

export function useBundles(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey,
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const { data, error } = await getBundles();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useBundle(id: string | null) {
  return useQuery({
    queryKey: [...queryKey, id],
    enabled: id !== null,
    queryFn: async () => {
      const { data, error } = await getBundle({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
  });
}

export function useCreateBundle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateBundleBody) => {
      const { data, error } = await createBundle({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      client.invalidateQueries({ queryKey });
      toast.success("Bundle created");
    },
  });
}

export function useUpdateBundle(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateBundleBody) => {
      const { data, error } = await updateBundle({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      client.invalidateQueries({ queryKey });
      toast.success("Bundle updated");
    },
  });
}

export function useDeleteBundle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteBundle({ path: { id } });
      if (error) {
        handleApiError(error);
        return false;
      }
      return data?.success ?? false;
    },
    onSuccess: (success) => {
      if (!success) return;
      client.invalidateQueries({ queryKey });
      toast.success("Bundle deleted");
    },
  });
}
