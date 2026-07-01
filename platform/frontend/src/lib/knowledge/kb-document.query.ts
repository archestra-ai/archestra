"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { deleteConnectorDocument, getConnectorDocument, getConnectorDocuments } =
  archestraApiSdk;

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
      if (error) {
        handleApiError(error);
        throw error;
      }
      return data;
    },
    enabled:
      Boolean(params.path.id) &&
      Boolean(params.path.docId) &&
      (params.enabled ?? true),
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
