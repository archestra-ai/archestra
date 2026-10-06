import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError } from "@/lib/utils/api";

const { getPublicFileLinks, revokePublicFileLink } = archestraApiSdk;

export type PublicFileLink =
  archestraApiTypes.GetPublicFileLinksResponses["200"]["data"][number];

export type PublicFileLinkScope = NonNullable<
  NonNullable<archestraApiTypes.GetPublicFileLinksData["query"]>["scope"]
>;

export function usePublicFileLinks({
  enabled = true,
  ...params
}: {
  scope: PublicFileLinkScope;
  limit: number;
  offset: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["public-file-links", params],
    queryFn: async () => {
      const { data, error } = await getPublicFileLinks({ query: params });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useRevokePublicFileLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await revokePublicFileLink({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["public-file-links"] });
      toast.success("Public link revoked");
    },
  });
}
