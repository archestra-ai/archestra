"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  getKnowledgeBaseDocuments,
  getKnowledgeBaseDocument,
  deleteKnowledgeBaseDocument,
} = archestraApiSdk;

type KnowledgeBaseDocumentsQuery = NonNullable<
  archestraApiTypes.GetKnowledgeBaseDocumentsData["query"]
>;

export type KnowledgeBaseDocumentListItem =
  archestraApiTypes.GetKnowledgeBaseDocumentsResponses["200"]["data"][number];

export type KnowledgeBaseDocumentDetail =
  archestraApiTypes.GetKnowledgeBaseDocumentResponses["200"];

export function useKnowledgeBaseDocuments(params: {
  knowledgeBaseId: string;
  limit: number;
  offset: number;
  search?: string;
  connectorId?: string;
}) {
  return useQuery({
    queryKey: [
      "knowledge-base-documents",
      params.knowledgeBaseId,
      params.limit,
      params.offset,
      params.search ?? "",
      params.connectorId ?? "",
    ],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const query: KnowledgeBaseDocumentsQuery & { connectorId?: string } = {
        limit: params.limit,
        offset: params.offset,
        ...(params.search ? { search: params.search } : {}),
        ...(params.connectorId && params.connectorId !== "all"
          ? { connectorId: params.connectorId }
          : {}),
      };
      const { data, error } = await getKnowledgeBaseDocuments({
        path: { id: params.knowledgeBaseId },
        query,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!params.knowledgeBaseId,
  });
}

export function useKnowledgeBaseDocument(params: {
  knowledgeBaseId: string;
  docId: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["knowledge-base-document", params.knowledgeBaseId, params.docId],
    queryFn: async () => {
      const { data, error } = await getKnowledgeBaseDocument({
        path: { id: params.knowledgeBaseId, docId: params.docId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled:
      Boolean(params.knowledgeBaseId) &&
      Boolean(params.docId) &&
      (params.enabled ?? true),
  });
}

export function useDeleteKnowledgeBaseDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { knowledgeBaseId: string; docId: string }) => {
      const { data, error } = await deleteKnowledgeBaseDocument({
        path: {
          id: params.knowledgeBaseId,
          docId: params.docId,
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({
        queryKey: ["knowledge-base-documents", variables.knowledgeBaseId],
      });
      queryClient.invalidateQueries({
        queryKey: ["knowledge-base-document", variables.knowledgeBaseId],
      });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Document deleted successfully");
    },
  });
}
