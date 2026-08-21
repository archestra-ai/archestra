"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toBulkOutcome } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const {
  bulkDeleteConnectorDocuments,
  deleteConnectorDocument,
  getConnectorDocument,
  getConnectorDocuments,
} = archestraApiSdk;

export type KnowledgeBaseDocumentListItem =
  archestraApiTypes.GetConnectorDocumentsResponses["200"]["data"][number];

export type KnowledgeBaseDocumentDetail =
  archestraApiTypes.GetConnectorDocumentResponses["200"];

type ConnectorDocumentsParams = Pick<
  archestraApiTypes.GetConnectorDocumentsData,
  "path" | "query"
>;

type ConnectorDocumentParams = Pick<
  archestraApiTypes.GetConnectorDocumentData,
  "path"
> & {
  enabled?: boolean;
};

export function useConnectorDocuments(params: ConnectorDocumentsParams) {
  const query = params.query ?? {};

  return useQuery({
    queryKey: [
      "connector-documents",
      params.path.id,
      query.limit ?? "",
      query.offset ?? "",
      query.search ?? "",
      query.group ?? "",
    ],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getConnectorDocuments({
        path: params.path,
        query,
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    enabled: !!params.path.id,
  });
}

export function useConnectorDocument(params: ConnectorDocumentParams) {
  return useQuery({
    queryKey: ["connector-document", params.path.id, params.path.docId],
    queryFn: async () => {
      const { data, error } = await getConnectorDocument({
        path: params.path,
      });
      // A stale/invisible `?document=<id>` deep link resolves to 404 — no-op
      // silently like the other by-id hooks instead of raising a toast.
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
    enabled:
      Boolean(params.path.id) &&
      Boolean(params.path.docId) &&
      (params.enabled ?? true),
  });
}

/**
 * Deletes a selection of a connector's synced documents in one request.
 *
 * Deliberately not `useDeleteConnectorDocument`, which toasts per call and so
 * would fire one toast per row.
 */
export function useBulkDeleteConnectorDocuments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      params:
        | { connectorId: string; documents: readonly { id: string }[] }
        | {
            connectorId: string;
            /**
             * Everything matching the table's current filters. Sent as the
             * filter rather than as ids: a connector's corpus routinely runs
             * to tens of thousands of documents, which no request body should
             * be asked to carry as uuids.
             */
            all: { search?: string; group?: string };
          },
    ) =>
      bulkDeleteConnectorDocuments({
        path: { id: params.connectorId },
        body:
          "all" in params
            ? { all: true as const, ...params.all }
            : { ids: params.documents.map((document) => document.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: (_data, _error, { connectorId }) => {
      queryClient.invalidateQueries({
        queryKey: ["connector-documents", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connector-documents", "all-matching"],
      });
    },
  });
}

export function useDeleteConnectorDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      path: archestraApiTypes.DeleteConnectorDocumentData["path"],
    ) => {
      const { data, error } = await deleteConnectorDocument({
        path,
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    onSuccess: (data, path) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["connector-documents", path.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["connector-document", path.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["connectors", path.id],
      });
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
      toast.success("Document deleted successfully");
    },
  });
}
