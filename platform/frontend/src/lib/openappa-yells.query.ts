import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readFileAsBase64 } from "@/lib/files/file-upload";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type OpenAppaYell = archestraApiTypes.GetOpenAppaYellResponses[200];
export function useOpenAppaYells(
  query: archestraApiTypes.GetOpenAppaYellsData["query"],
  enabled = true,
) {
  return useQuery({
    queryKey: ["openappa-yells", "list", query],
    enabled,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenAppaYells({ query });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}
export function useOpenAppaYellsSummary(enabled = true) {
  return useQuery({
    queryKey: ["openappa-yells", "summary"],
    enabled,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenAppaYellsSummary();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}
export function useResolveOpenAppaYell() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, resolved }: { id: string; resolved: boolean }) => {
      const { data, error } = await archestraApiSdk.updateOpenAppaYell({
        path: { id },
        body: { resolved },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["openappa-yells"] }),
  });
}

export function useOpenAppaYellArchive() {
  return useMutation({
    mutationFn: async ({
      id,
      download = false,
    }: {
      id: string;
      download?: boolean;
    }) => {
      const { data, error } = await archestraApiSdk.downloadOpenAppaYell({
        path: { id },
        parseAs: "blob",
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      if (!(data instanceof Blob))
        throw new Error("Diagnostic archive unavailable");
      const file = new File([data], `openappa-yell-${id}.json.gz`, {
        type: "application/gzip",
      });
      if (download) {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return null;
      }
      return {
        type: "file" as const,
        mediaType: file.type,
        filename: file.name,
        url: `data:${file.type};base64,${await readFileAsBase64(file)}`,
      };
    },
  });
}
